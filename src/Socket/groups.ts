import { proto } from '../../WAProto/index.js'
import type { GroupMetadata, GroupParticipant, ParticipantAction, SocketConfig, WAMessageKey } from '../Types'
import { WAMessageAddressingMode, WAMessageStubType } from '../Types'
import { generateMessageIDV2, unixTimestampSeconds } from '../Utils'
import {
	type BinaryNode,
	getBinaryNodeChild,
	getBinaryNodeChildren,
	getBinaryNodeChildString,
	isLidUser,
	isPnUser,
	jidEncode,
	jidNormalizedUser
} from '../WABinary'
import { makeChatsSocket } from './chats'
import { trace } from '../Utils/trace-logger'

export const makeGroupsSocket = (config: SocketConfig) => {
	trace('groups', 'makeGroupsSocket:enter')
	const sock = makeChatsSocket(config)
	const { authState, ev, query, upsertMessage } = sock

	const groupQuery = async (jid: string, type: 'get' | 'set', content: BinaryNode[]) => {
		trace('groups', 'groupQuery:enter', { jid, type, contentCount: content.length })
		try {
			const result = await query({
				tag: 'iq',
				attrs: {
					type,
					xmlns: 'w:g2',
					to: jid
				},
				content
			})
			trace('groups', 'groupQuery:return', { jid, type })
			return result
		} catch (error) {
			trace('groups', 'groupQuery:error', { jid, type, error: (error as Error).message })
			throw error
		}
	}

	const groupMetadata = async (jid: string) => {
		trace('groups', 'groupMetadata:enter', { jid })
		try {
			const result = await groupQuery(jid, 'get', [{ tag: 'query', attrs: { request: 'interactive' } }])
			const metadata = extractGroupMetadata(result)
			trace('groups', 'groupMetadata:return', { jid, subject: metadata.subject })
			return metadata
		} catch (error) {
			trace('groups', 'groupMetadata:error', { jid, error: (error as Error).message })
			throw error
		}
	}

	const groupFetchAllParticipating = async () => {
		trace('groups', 'groupFetchAllParticipating:enter')
		try {
			const result = await query({
				tag: 'iq',
				attrs: {
					to: '@g.us',
					xmlns: 'w:g2',
					type: 'get'
				},
				content: [
					{
						tag: 'participating',
						attrs: {},
						content: [
							{ tag: 'participants', attrs: {} },
							{ tag: 'description', attrs: {} }
						]
					}
				]
			})
			const data: { [_: string]: GroupMetadata } = {}
			const groupsChild = getBinaryNodeChild(result, 'groups')
			if (groupsChild) {
				const groups = getBinaryNodeChildren(groupsChild, 'group')
				for (const groupNode of groups) {
					const meta = extractGroupMetadata({
						tag: 'result',
						attrs: {},
						content: [groupNode]
					})
					data[meta.id] = meta
				}
			}

			sock.ev.emit('groups.update', Object.values(data))

			trace('groups', 'groupFetchAllParticipating:return', { count: Object.keys(data).length })
			return data
		} catch (error) {
			trace('groups', 'groupFetchAllParticipating:error', { error: (error as Error).message })
			throw error
		}
	}

	sock.ws.on('CB:ib,,dirty', async (node: BinaryNode) => {
		const { attrs } = getBinaryNodeChild(node, 'dirty')!
		trace('groups', 'event:CB:ib,,dirty', { type: attrs.type })
		if (attrs.type !== 'groups') {
			return
		}

		await groupFetchAllParticipating()
		await sock.cleanDirtyBits('groups')
	})

	trace('groups', 'makeGroupsSocket:return')
	return {
		...sock,
		groupMetadata,
		groupCreate: async (subject: string, participants: string[]) => {
			trace('groups', 'groupCreate:enter', { subject, participantCount: participants.length })
			try {
				const key = generateMessageIDV2()
				const result = await groupQuery('@g.us', 'set', [
					{
						tag: 'create',
						attrs: {
							subject,
							key
						},
						content: participants.map(jid => ({
							tag: 'participant',
							attrs: { jid }
						}))
					}
				])
				const metadata = extractGroupMetadata(result)
				trace('groups', 'groupCreate:return', { id: metadata.id })
				return metadata
			} catch (error) {
				trace('groups', 'groupCreate:error', { subject, error: (error as Error).message })
				throw error
			}
		},
		groupLeave: async (id: string) => {
			trace('groups', 'groupLeave:enter', { id })
			try {
				await groupQuery('@g.us', 'set', [
					{
						tag: 'leave',
						attrs: {},
						content: [{ tag: 'group', attrs: { id } }]
					}
				])
				trace('groups', 'groupLeave:return', { id })
			} catch (error) {
				trace('groups', 'groupLeave:error', { id, error: (error as Error).message })
				throw error
			}
		},
		groupUpdateSubject: async (jid: string, subject: string) => {
			trace('groups', 'groupUpdateSubject:enter', { jid, subject })
			try {
				await groupQuery(jid, 'set', [
					{
						tag: 'subject',
						attrs: {},
						content: Buffer.from(subject, 'utf-8')
					}
				])
				trace('groups', 'groupUpdateSubject:return', { jid })
			} catch (error) {
				trace('groups', 'groupUpdateSubject:error', { jid, error: (error as Error).message })
				throw error
			}
		},
		groupRequestParticipantsList: async (jid: string) => {
			trace('groups', 'groupRequestParticipantsList:enter', { jid })
			try {
				const result = await groupQuery(jid, 'get', [
					{
						tag: 'membership_approval_requests',
						attrs: {}
					}
				])
				const node = getBinaryNodeChild(result, 'membership_approval_requests')
				const participants = getBinaryNodeChildren(node, 'membership_approval_request')
				const attrs = participants.map(v => v.attrs)
				trace('groups', 'groupRequestParticipantsList:return', { jid, count: attrs.length })
				return attrs
			} catch (error) {
				trace('groups', 'groupRequestParticipantsList:error', { jid, error: (error as Error).message })
				throw error
			}
		},
		groupRequestParticipantsUpdate: async (jid: string, participants: string[], action: 'approve' | 'reject') => {
			trace('groups', 'groupRequestParticipantsUpdate:enter', { jid, participantCount: participants.length, action })
			try {
				const result = await groupQuery(jid, 'set', [
					{
						tag: 'membership_requests_action',
						attrs: {},
						content: [
							{
								tag: action,
								attrs: {},
								content: participants.map(jid => ({
									tag: 'participant',
									attrs: { jid }
								}))
							}
						]
					}
				])
				const node = getBinaryNodeChild(result, 'membership_requests_action')
				const nodeAction = getBinaryNodeChild(node, action)
				const participantsAffected = getBinaryNodeChildren(nodeAction, 'participant')
				const resultData = participantsAffected.map(p => {
					return { status: p.attrs.error || '200', jid: p.attrs.jid }
				})
				trace('groups', 'groupRequestParticipantsUpdate:return', { jid, affectedCount: resultData.length })
				return resultData
			} catch (error) {
				trace('groups', 'groupRequestParticipantsUpdate:error', { jid, error: (error as Error).message })
				throw error
			}
		},
		groupParticipantsUpdate: async (jid: string, participants: string[], action: ParticipantAction) => {
			trace('groups', 'groupParticipantsUpdate:enter', { jid, participantCount: participants.length, action })
			try {
				const result = await groupQuery(jid, 'set', [
					{
						tag: action,
						attrs: {},
						content: participants.map(jid => ({
							tag: 'participant',
							attrs: { jid }
						}))
					}
				])
				const node = getBinaryNodeChild(result, action)
				const participantsAffected = getBinaryNodeChildren(node, 'participant')
				const resultData = participantsAffected.map(p => {
					return { status: p.attrs.error || '200', jid: p.attrs.jid, content: p }
				})
				trace('groups', 'groupParticipantsUpdate:return', { jid, affectedCount: resultData.length })
				return resultData
			} catch (error) {
				trace('groups', 'groupParticipantsUpdate:error', { jid, error: (error as Error).message })
				throw error
			}
		},
		groupUpdateDescription: async (jid: string, description?: string) => {
			trace('groups', 'groupUpdateDescription:enter', { jid, hasDescription: !!description })
			try {
				const metadata = await groupMetadata(jid)
				const prev = metadata.descId ?? null

				await groupQuery(jid, 'set', [
					{
						tag: 'description',
						attrs: {
							...(description ? { id: generateMessageIDV2() } : { delete: 'true' }),
							...(prev ? { prev } : {})
						},
						content: description ? [{ tag: 'body', attrs: {}, content: Buffer.from(description, 'utf-8') }] : undefined
					}
				])
				trace('groups', 'groupUpdateDescription:return', { jid })
			} catch (error) {
				trace('groups', 'groupUpdateDescription:error', { jid, error: (error as Error).message })
				throw error
			}
		},
		groupInviteCode: async (jid: string) => {
			trace('groups', 'groupInviteCode:enter', { jid })
			try {
				const result = await groupQuery(jid, 'get', [{ tag: 'invite', attrs: {} }])
				const inviteNode = getBinaryNodeChild(result, 'invite')
				const code = inviteNode?.attrs.code
				trace('groups', 'groupInviteCode:return', { jid, hasCode: !!code })
				return code
			} catch (error) {
				trace('groups', 'groupInviteCode:error', { jid, error: (error as Error).message })
				throw error
			}
		},
		groupRevokeInvite: async (jid: string) => {
			trace('groups', 'groupRevokeInvite:enter', { jid })
			try {
				const result = await groupQuery(jid, 'set', [{ tag: 'invite', attrs: {} }])
				const inviteNode = getBinaryNodeChild(result, 'invite')
				const code = inviteNode?.attrs.code
				trace('groups', 'groupRevokeInvite:return', { jid, code })
				return code
			} catch (error) {
				trace('groups', 'groupRevokeInvite:error', { jid, error: (error as Error).message })
				throw error
			}
		},
		groupAcceptInvite: async (code: string) => {
			trace('groups', 'groupAcceptInvite:enter', { code })
			try {
				const results = await groupQuery('@g.us', 'set', [{ tag: 'invite', attrs: { code } }])
				const result = getBinaryNodeChild(results, 'group')
				const jid = result?.attrs.jid
				trace('groups', 'groupAcceptInvite:return', { jid })
				return jid
			} catch (error) {
				trace('groups', 'groupAcceptInvite:error', { code, error: (error as Error).message })
				throw error
			}
		},

		/**
		 * revoke a v4 invite for someone
		 * @param groupJid group jid
		 * @param invitedJid jid of person you invited
		 * @returns true if successful
		 */
		groupRevokeInviteV4: async (groupJid: string, invitedJid: string) => {
			trace('groups', 'groupRevokeInviteV4:enter', { groupJid, invitedJid })
			try {
				const result = await groupQuery(groupJid, 'set', [
					{ tag: 'revoke', attrs: {}, content: [{ tag: 'participant', attrs: { jid: invitedJid } }] }
				])
				const success = !!result
				trace('groups', 'groupRevokeInviteV4:return', { groupJid, success })
				return success
			} catch (error) {
				trace('groups', 'groupRevokeInviteV4:error', { groupJid, error: (error as Error).message })
				throw error
			}
		},

		/**
		 * accept a GroupInviteMessage
		 * @param key the key of the invite message, or optionally only provide the jid of the person who sent the invite
		 * @param inviteMessage the message to accept
		 */
		groupAcceptInviteV4: ev.createBufferedFunction(
			async (key: string | WAMessageKey, inviteMessage: proto.Message.IGroupInviteMessage) => {
				trace('groups', 'groupAcceptInviteV4:enter', { groupJid: inviteMessage.groupJid })
				try {
					key = typeof key === 'string' ? { remoteJid: key } : key
					const results = await groupQuery(inviteMessage.groupJid!, 'set', [
						{
							tag: 'accept',
							attrs: {
								code: inviteMessage.inviteCode!,
								expiration: inviteMessage.inviteExpiration!.toString(),
								admin: key.remoteJid!
							}
						}
					])

					if (key.id) {
						inviteMessage = proto.Message.GroupInviteMessage.fromObject(inviteMessage)
						inviteMessage.inviteExpiration = 0
						inviteMessage.inviteCode = ''
						ev.emit('messages.update', [
							{
								key,
								update: {
									message: {
										groupInviteMessage: inviteMessage
									}
								}
							}
						])
					}

					await upsertMessage(
						{
							key: {
								remoteJid: inviteMessage.groupJid,
								id: generateMessageIDV2(sock.user?.id),
								fromMe: false,
								participant: key.remoteJid
							},
							messageStubType: WAMessageStubType.GROUP_PARTICIPANT_ADD,
							messageStubParameters: [JSON.stringify(authState.creds.me)],
							participant: key.remoteJid,
							messageTimestamp: unixTimestampSeconds()
						},
						'notify'
					)

					trace('groups', 'groupAcceptInviteV4:return', { from: results.attrs.from })
					return results.attrs.from
				} catch (error) {
					trace('groups', 'groupAcceptInviteV4:error', { error: (error as Error).message })
					throw error
				}
			}
		),
		groupGetInviteInfo: async (code: string) => {
			trace('groups', 'groupGetInviteInfo:enter', { code })
			try {
				const results = await groupQuery('@g.us', 'get', [{ tag: 'invite', attrs: { code } }])
				const meta = extractGroupMetadata(results)
				trace('groups', 'groupGetInviteInfo:return', { groupId: meta.id })
				return meta
			} catch (error) {
				trace('groups', 'groupGetInviteInfo:error', { code, error: (error as Error).message })
				throw error
			}
		},
		groupToggleEphemeral: async (jid: string, ephemeralExpiration: number) => {
			trace('groups', 'groupToggleEphemeral:enter', { jid, ephemeralExpiration })
			try {
				const content: BinaryNode = ephemeralExpiration
					? { tag: 'ephemeral', attrs: { expiration: ephemeralExpiration.toString() } }
					: { tag: 'not_ephemeral', attrs: {} }
				await groupQuery(jid, 'set', [content])
				trace('groups', 'groupToggleEphemeral:return', { jid })
			} catch (error) {
				trace('groups', 'groupToggleEphemeral:error', { jid, error: (error as Error).message })
				throw error
			}
		},
		groupSettingUpdate: async (jid: string, setting: 'announcement' | 'not_announcement' | 'locked' | 'unlocked') => {
			trace('groups', 'groupSettingUpdate:enter', { jid, setting })
			try {
				await groupQuery(jid, 'set', [{ tag: setting, attrs: {} }])
				trace('groups', 'groupSettingUpdate:return', { jid, setting })
			} catch (error) {
				trace('groups', 'groupSettingUpdate:error', { jid, setting, error: (error as Error).message })
				throw error
			}
		},
		groupMemberAddMode: async (jid: string, mode: 'admin_add' | 'all_member_add') => {
			trace('groups', 'groupMemberAddMode:enter', { jid, mode })
			try {
				await groupQuery(jid, 'set', [{ tag: 'member_add_mode', attrs: {}, content: mode }])
				trace('groups', 'groupMemberAddMode:return', { jid, mode })
			} catch (error) {
				trace('groups', 'groupMemberAddMode:error', { jid, mode, error: (error as Error).message })
				throw error
			}
		},
		groupJoinApprovalMode: async (jid: string, mode: 'on' | 'off') => {
			trace('groups', 'groupJoinApprovalMode:enter', { jid, mode })
			try {
				await groupQuery(jid, 'set', [
					{ tag: 'membership_approval_mode', attrs: {}, content: [{ tag: 'group_join', attrs: { state: mode } }] }
				])
				trace('groups', 'groupJoinApprovalMode:return', { jid, mode })
			} catch (error) {
				trace('groups', 'groupJoinApprovalMode:error', { jid, mode, error: (error as Error).message })
				throw error
			}
		},
		groupFetchAllParticipating
	}
}

export const extractGroupMetadata = (result: BinaryNode) => {
	trace('groups', 'extractGroupMetadata:enter')
	const group = getBinaryNodeChild(result, 'group')!
	const descChild = getBinaryNodeChild(group, 'description')
	let desc: string | undefined
	let descId: string | undefined
	let descOwner: string | undefined
	let descOwnerPn: string | undefined
	let descTime: number | undefined
	if (descChild) {
		desc = getBinaryNodeChildString(descChild, 'body')
		descOwner = descChild.attrs.participant ? jidNormalizedUser(descChild.attrs.participant) : undefined
		descOwnerPn = descChild.attrs.participant_pn ? jidNormalizedUser(descChild.attrs.participant_pn) : undefined
		descTime = +descChild.attrs.t!
		descId = descChild.attrs.id
	}

	const groupId = group.attrs.id!.includes('@') ? group.attrs.id : jidEncode(group.attrs.id!, 'g.us')
	const eph = getBinaryNodeChild(group, 'ephemeral')?.attrs.expiration
	const memberAddMode = getBinaryNodeChildString(group, 'member_add_mode') === 'all_member_add'
	const metadata: GroupMetadata = {
		id: groupId!,
		notify: group.attrs.notify,
		addressingMode: group.attrs.addressing_mode === 'lid' ? WAMessageAddressingMode.LID : WAMessageAddressingMode.PN,
		subject: group.attrs.subject!,
		subjectOwner: group.attrs.s_o,
		subjectOwnerPn: group.attrs.s_o_pn,
		subjectTime: +group.attrs.s_t!,
		size: group.attrs.size ? +group.attrs.size : getBinaryNodeChildren(group, 'participant').length,
		creation: +group.attrs.creation!,
		owner: group.attrs.creator ? jidNormalizedUser(group.attrs.creator) : undefined,
		ownerPn: group.attrs.creator_pn ? jidNormalizedUser(group.attrs.creator_pn) : undefined,
		owner_country_code: group.attrs.creator_country_code,
		desc,
		descId,
		descOwner,
		descOwnerPn,
		descTime,
		linkedParent: getBinaryNodeChild(group, 'linked_parent')?.attrs.jid || undefined,
		restrict: !!getBinaryNodeChild(group, 'locked'),
		announce: !!getBinaryNodeChild(group, 'announcement'),
		isCommunity: !!getBinaryNodeChild(group, 'parent'),
		isCommunityAnnounce: !!getBinaryNodeChild(group, 'default_sub_group'),
		joinApprovalMode: !!getBinaryNodeChild(group, 'membership_approval_mode'),
		memberAddMode,
		participants: getBinaryNodeChildren(group, 'participant').map(({ attrs }) => {
			return {
				id: attrs.jid!,
				phoneNumber: isLidUser(attrs.jid) && isPnUser(attrs.phone_number) ? attrs.phone_number : undefined,
				lid: isPnUser(attrs.jid) && isLidUser(attrs.lid) ? attrs.lid : undefined,
				admin: (attrs.type || null) as GroupParticipant['admin']
			}
		}),
		ephemeralDuration: eph ? +eph : undefined
	}
	trace('groups', 'extractGroupMetadata:return', { id: metadata.id, size: metadata.size })
	return metadata
}

export type GroupsSocket = ReturnType<typeof makeGroupsSocket>