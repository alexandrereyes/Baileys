import { proto } from '../../WAProto/index.js'
import {
	type GroupMetadata,
	type GroupParticipant,
	type ParticipantAction,
	type SocketConfig,
	type WAMessageKey,
	WAMessageStubType
} from '../Types'
import { generateMessageID, generateMessageIDV2, unixTimestampSeconds } from '../Utils'
import logger from '../Utils/logger'
import {
	type BinaryNode,
	getBinaryNodeChild,
	getBinaryNodeChildren,
	getBinaryNodeChildString,
	jidEncode,
	jidNormalizedUser
} from '../WABinary'
import { makeBusinessSocket } from './business'
import { trace } from '../Utils/trace-logger'

export const makeCommunitiesSocket = (config: SocketConfig) => {
	trace('communities', 'makeCommunitiesSocket:enter')
	const sock = makeBusinessSocket(config)
	const { authState, ev, query, upsertMessage } = sock

	const communityQuery = async (jid: string, type: 'get' | 'set', content: BinaryNode[]) => {
		trace('communities', 'communityQuery:enter', { jid, type, contentCount: content.length })
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
			trace('communities', 'communityQuery:return', { jid, type })
			return result
		} catch (error) {
			trace('communities', 'communityQuery:error', { jid, type, error: (error as Error).message })
			throw error
		}
	}

	const communityMetadata = async (jid: string) => {
		trace('communities', 'communityMetadata:enter', { jid })
		try {
			const result = await communityQuery(jid, 'get', [{ tag: 'query', attrs: { request: 'interactive' } }])
			const metadata = extractCommunityMetadata(result)
			trace('communities', 'communityMetadata:return', { jid, subject: metadata.subject })
			return metadata
		} catch (error) {
			trace('communities', 'communityMetadata:error', { jid, error: (error as Error).message })
			throw error
		}
	}

	const communityFetchAllParticipating = async () => {
		trace('communities', 'communityFetchAllParticipating:enter')
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
			const communitiesChild = getBinaryNodeChild(result, 'communities')
			if (communitiesChild) {
				const communities = getBinaryNodeChildren(communitiesChild, 'community')
				for (const communityNode of communities) {
					const meta = extractCommunityMetadata({
						tag: 'result',
						attrs: {},
						content: [communityNode]
					})
					data[meta.id] = meta
				}
			}

			sock.ev.emit('groups.update', Object.values(data))

			trace('communities', 'communityFetchAllParticipating:return', { count: Object.keys(data).length })
			return data
		} catch (error) {
			trace('communities', 'communityFetchAllParticipating:error', { error: (error as Error).message })
			throw error
		}
	}

	async function parseGroupResult(node: BinaryNode) {
		trace('communities', 'parseGroupResult:enter')
		logger.info({ node }, 'parseGroupResult')
		const groupNode = getBinaryNodeChild(node, 'group')
		if (groupNode) {
			try {
				logger.info({ groupNode }, 'groupNode')
				const metadata = await sock.groupMetadata(`${groupNode.attrs.id}@g.us`)
				trace('communities', 'parseGroupResult:return', { hasMetadata: !!metadata })
				return metadata ? metadata : Optional.empty()
			} catch (error) {
				console.error('Error parsing group metadata:', error)
				trace('communities', 'parseGroupResult:return-empty', { error: (error as Error).message })
				return Optional.empty()
			}
		}

		trace('communities', 'parseGroupResult:return-empty', { reason: 'no-group-node' })
		return Optional.empty()
	}

	const Optional = {
		empty: () => null,
		of: (value: null) => (value !== null ? { value } : null)
	}

	sock.ws.on('CB:ib,,dirty', async (node: BinaryNode) => {
		const { attrs } = getBinaryNodeChild(node, 'dirty')!
		trace('communities', 'event:CB:ib,,dirty', { type: attrs.type })
		if (attrs.type !== 'communities') {
			return
		}

		await communityFetchAllParticipating()
		await sock.cleanDirtyBits('groups')
	})

	trace('communities', 'makeCommunitiesSocket:return')
	return {
		...sock,
		communityMetadata,
		communityCreate: async (subject: string, body: string) => {
			trace('communities', 'communityCreate:enter', { subject })
			try {
				const descriptionId = generateMessageID().substring(0, 12)

				const result = await communityQuery('@g.us', 'set', [
					{
						tag: 'create',
						attrs: { subject },
						content: [
							{
								tag: 'description',
								attrs: { id: descriptionId },
								content: [
									{
										tag: 'body',
										attrs: {},
										content: Buffer.from(body || '', 'utf-8')
									}
								]
							},
							{
								tag: 'parent',
								attrs: { default_membership_approval_mode: 'request_required' }
							},
							{
								tag: 'allow_non_admin_sub_group_creation',
								attrs: {}
							},
							{
								tag: 'create_general_chat',
								attrs: {}
							}
						]
					}
				])

				const parsed = await parseGroupResult(result)
				trace('communities', 'communityCreate:return', { subject, hasResult: !!parsed })
				return parsed
			} catch (error) {
				trace('communities', 'communityCreate:error', { subject, error: (error as Error).message })
				throw error
			}
		},
		communityCreateGroup: async (subject: string, participants: string[], parentCommunityJid: string) => {
			trace('communities', 'communityCreateGroup:enter', { subject, participantCount: participants.length, parentCommunityJid })
			try {
				const key = generateMessageIDV2()
				const result = await communityQuery('@g.us', 'set', [
					{
						tag: 'create',
						attrs: {
							subject,
							key
						},
						content: [
							...participants.map(jid => ({
								tag: 'participant',
								attrs: { jid }
							})),
							{ tag: 'linked_parent', attrs: { jid: parentCommunityJid } }
						]
					}
				])
				const parsed = await parseGroupResult(result)
				trace('communities', 'communityCreateGroup:return', { subject, hasResult: !!parsed })
				return parsed
			} catch (error) {
				trace('communities', 'communityCreateGroup:error', { subject, error: (error as Error).message })
				throw error
			}
		},
		communityLeave: async (id: string) => {
			trace('communities', 'communityLeave:enter', { id })
			try {
				await communityQuery('@g.us', 'set', [
					{
						tag: 'leave',
						attrs: {},
						content: [{ tag: 'community', attrs: { id } }]
					}
				])
				trace('communities', 'communityLeave:return', { id })
			} catch (error) {
				trace('communities', 'communityLeave:error', { id, error: (error as Error).message })
				throw error
			}
		},
		communityUpdateSubject: async (jid: string, subject: string) => {
			trace('communities', 'communityUpdateSubject:enter', { jid, subject })
			try {
				await communityQuery(jid, 'set', [
					{
						tag: 'subject',
						attrs: {},
						content: Buffer.from(subject, 'utf-8')
					}
				])
				trace('communities', 'communityUpdateSubject:return', { jid })
			} catch (error) {
				trace('communities', 'communityUpdateSubject:error', { jid, error: (error as Error).message })
				throw error
			}
		},
		communityLinkGroup: async (groupJid: string, parentCommunityJid: string) => {
			trace('communities', 'communityLinkGroup:enter', { groupJid, parentCommunityJid })
			try {
				await communityQuery(parentCommunityJid, 'set', [
					{
						tag: 'links',
						attrs: {},
						content: [
							{
								tag: 'link',
								attrs: { link_type: 'sub_group' },
								content: [{ tag: 'group', attrs: { jid: groupJid } }]
							}
						]
					}
				])
				trace('communities', 'communityLinkGroup:return', { groupJid, parentCommunityJid })
			} catch (error) {
				trace('communities', 'communityLinkGroup:error', { groupJid, error: (error as Error).message })
				throw error
			}
		},
		communityUnlinkGroup: async (groupJid: string, parentCommunityJid: string) => {
			trace('communities', 'communityUnlinkGroup:enter', { groupJid, parentCommunityJid })
			try {
				await communityQuery(parentCommunityJid, 'set', [
					{
						tag: 'unlink',
						attrs: { unlink_type: 'sub_group' },
						content: [{ tag: 'group', attrs: { jid: groupJid } }]
					}
				])
				trace('communities', 'communityUnlinkGroup:return', { groupJid })
			} catch (error) {
				trace('communities', 'communityUnlinkGroup:error', { groupJid, error: (error as Error).message })
				throw error
			}
		},
		communityFetchLinkedGroups: async (jid: string) => {
			trace('communities', 'communityFetchLinkedGroups:enter', { jid })
			try {
				let communityJid = jid
				let isCommunity = false

				const metadata = await sock.groupMetadata(jid)
				if (metadata.linkedParent) {
					communityJid = metadata.linkedParent
				} else {
					isCommunity = true
				}

				const result = await communityQuery(communityJid, 'get', [{ tag: 'sub_groups', attrs: {} }])

				const linkedGroupsData = []
				const subGroupsNode = getBinaryNodeChild(result, 'sub_groups')
				if (subGroupsNode) {
					const groupNodes = getBinaryNodeChildren(subGroupsNode, 'group')
					for (const groupNode of groupNodes) {
						linkedGroupsData.push({
							id: groupNode.attrs.id ? jidEncode(groupNode.attrs.id, 'g.us') : undefined,
							subject: groupNode.attrs.subject || '',
							creation: groupNode.attrs.creation ? Number(groupNode.attrs.creation) : undefined,
							owner: groupNode.attrs.creator ? jidNormalizedUser(groupNode.attrs.creator) : undefined,
							size: groupNode.attrs.size ? Number(groupNode.attrs.size) : undefined
						})
					}
				}

				const response = {
					communityJid,
					isCommunity,
					linkedGroups: linkedGroupsData
				}
				trace('communities', 'communityFetchLinkedGroups:return', { jid, count: linkedGroupsData.length })
				return response
			} catch (error) {
				trace('communities', 'communityFetchLinkedGroups:error', { jid, error: (error as Error).message })
				throw error
			}
		},
		communityRequestParticipantsList: async (jid: string) => {
			trace('communities', 'communityRequestParticipantsList:enter', { jid })
			try {
				const result = await communityQuery(jid, 'get', [
					{
						tag: 'membership_approval_requests',
						attrs: {}
					}
				])
				const node = getBinaryNodeChild(result, 'membership_approval_requests')
				const participants = getBinaryNodeChildren(node, 'membership_approval_request')
				const attrs = participants.map(v => v.attrs)
				trace('communities', 'communityRequestParticipantsList:return', { jid, count: attrs.length })
				return attrs
			} catch (error) {
				trace('communities', 'communityRequestParticipantsList:error', { jid, error: (error as Error).message })
				throw error
			}
		},
		communityRequestParticipantsUpdate: async (jid: string, participants: string[], action: 'approve' | 'reject') => {
			trace('communities', 'communityRequestParticipantsUpdate:enter', { jid, participantCount: participants.length, action })
			try {
				const result = await communityQuery(jid, 'set', [
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
				trace('communities', 'communityRequestParticipantsUpdate:return', { jid, affectedCount: resultData.length })
				return resultData
			} catch (error) {
				trace('communities', 'communityRequestParticipantsUpdate:error', { jid, error: (error as Error).message })
				throw error
			}
		},
		communityParticipantsUpdate: async (jid: string, participants: string[], action: ParticipantAction) => {
			trace('communities', 'communityParticipantsUpdate:enter', { jid, participantCount: participants.length, action })
			try {
				const result = await communityQuery(jid, 'set', [
					{
						tag: action,
						attrs: action === 'remove' ? { linked_groups: 'true' } : {},
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
				trace('communities', 'communityParticipantsUpdate:return', { jid, affectedCount: resultData.length })
				return resultData
			} catch (error) {
				trace('communities', 'communityParticipantsUpdate:error', { jid, error: (error as Error).message })
				throw error
			}
		},
		communityUpdateDescription: async (jid: string, description?: string) => {
			trace('communities', 'communityUpdateDescription:enter', { jid, hasDescription: !!description })
			try {
				const metadata = await communityMetadata(jid)
				const prev = metadata.descId ?? null

				await communityQuery(jid, 'set', [
					{
						tag: 'description',
						attrs: {
							...(description ? { id: generateMessageID() } : { delete: 'true' }),
							...(prev ? { prev } : {})
						},
						content: description ? [{ tag: 'body', attrs: {}, content: Buffer.from(description, 'utf-8') }] : undefined
					}
				])
				trace('communities', 'communityUpdateDescription:return', { jid })
			} catch (error) {
				trace('communities', 'communityUpdateDescription:error', { jid, error: (error as Error).message })
				throw error
			}
		},
		communityInviteCode: async (jid: string) => {
			trace('communities', 'communityInviteCode:enter', { jid })
			try {
				const result = await communityQuery(jid, 'get', [{ tag: 'invite', attrs: {} }])
				const inviteNode = getBinaryNodeChild(result, 'invite')
				const code = inviteNode?.attrs.code
				trace('communities', 'communityInviteCode:return', { jid, hasCode: !!code })
				return code
			} catch (error) {
				trace('communities', 'communityInviteCode:error', { jid, error: (error as Error).message })
				throw error
			}
		},
		communityRevokeInvite: async (jid: string) => {
			trace('communities', 'communityRevokeInvite:enter', { jid })
			try {
				const result = await communityQuery(jid, 'set', [{ tag: 'invite', attrs: {} }])
				const inviteNode = getBinaryNodeChild(result, 'invite')
				const code = inviteNode?.attrs.code
				trace('communities', 'communityRevokeInvite:return', { jid, code })
				return code
			} catch (error) {
				trace('communities', 'communityRevokeInvite:error', { jid, error: (error as Error).message })
				throw error
			}
		},
		communityAcceptInvite: async (code: string) => {
			trace('communities', 'communityAcceptInvite:enter', { code })
			try {
				const results = await communityQuery('@g.us', 'set', [{ tag: 'invite', attrs: { code } }])
				const result = getBinaryNodeChild(results, 'community')
				const jid = result?.attrs.jid
				trace('communities', 'communityAcceptInvite:return', { jid })
				return jid
			} catch (error) {
				trace('communities', 'communityAcceptInvite:error', { code, error: (error as Error).message })
				throw error
			}
		},

		/**
		 * revoke a v4 invite for someone
		 * @param communityJid community jid
		 * @param invitedJid jid of person you invited
		 * @returns true if successful
		 */
		communityRevokeInviteV4: async (communityJid: string, invitedJid: string) => {
			trace('communities', 'communityRevokeInviteV4:enter', { communityJid, invitedJid })
			try {
				const result = await communityQuery(communityJid, 'set', [
					{ tag: 'revoke', attrs: {}, content: [{ tag: 'participant', attrs: { jid: invitedJid } }] }
				])
				const success = !!result
				trace('communities', 'communityRevokeInviteV4:return', { communityJid, success })
				return success
			} catch (error) {
				trace('communities', 'communityRevokeInviteV4:error', { communityJid, error: (error as Error).message })
				throw error
			}
		},

		/**
		 * accept a CommunityInviteMessage
		 * @param key the key of the invite message, or optionally only provide the jid of the person who sent the invite
		 * @param inviteMessage the message to accept
		 */
		communityAcceptInviteV4: ev.createBufferedFunction(
			async (key: string | WAMessageKey, inviteMessage: proto.Message.IGroupInviteMessage) => {
				trace('communities', 'communityAcceptInviteV4:enter', { groupJid: inviteMessage.groupJid })
				try {
					key = typeof key === 'string' ? { remoteJid: key } : key
					const results = await communityQuery(inviteMessage.groupJid!, 'set', [
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

					trace('communities', 'communityAcceptInviteV4:return', { from: results.attrs.from })
					return results.attrs.from
				} catch (error) {
					trace('communities', 'communityAcceptInviteV4:error', { error: (error as Error).message })
					throw error
				}
			}
		),
		communityGetInviteInfo: async (code: string) => {
			trace('communities', 'communityGetInviteInfo:enter', { code })
			try {
				const results = await communityQuery('@g.us', 'get', [{ tag: 'invite', attrs: { code } }])
				const meta = extractCommunityMetadata(results)
				trace('communities', 'communityGetInviteInfo:return', { communityId: meta.id })
				return meta
			} catch (error) {
				trace('communities', 'communityGetInviteInfo:error', { code, error: (error as Error).message })
				throw error
			}
		},
		communityToggleEphemeral: async (jid: string, ephemeralExpiration: number) => {
			trace('communities', 'communityToggleEphemeral:enter', { jid, ephemeralExpiration })
			try {
				const content: BinaryNode = ephemeralExpiration
					? { tag: 'ephemeral', attrs: { expiration: ephemeralExpiration.toString() } }
					: { tag: 'not_ephemeral', attrs: {} }
				await communityQuery(jid, 'set', [content])
				trace('communities', 'communityToggleEphemeral:return', { jid })
			} catch (error) {
				trace('communities', 'communityToggleEphemeral:error', { jid, error: (error as Error).message })
				throw error
			}
		},
		communitySettingUpdate: async (
			jid: string,
			setting: 'announcement' | 'not_announcement' | 'locked' | 'unlocked'
		) => {
			trace('communities', 'communitySettingUpdate:enter', { jid, setting })
			try {
				await communityQuery(jid, 'set', [{ tag: setting, attrs: {} }])
				trace('communities', 'communitySettingUpdate:return', { jid, setting })
			} catch (error) {
				trace('communities', 'communitySettingUpdate:error', { jid, setting, error: (error as Error).message })
				throw error
			}
		},
		communityMemberAddMode: async (jid: string, mode: 'admin_add' | 'all_member_add') => {
			trace('communities', 'communityMemberAddMode:enter', { jid, mode })
			try {
				await communityQuery(jid, 'set', [{ tag: 'member_add_mode', attrs: {}, content: mode }])
				trace('communities', 'communityMemberAddMode:return', { jid, mode })
			} catch (error) {
				trace('communities', 'communityMemberAddMode:error', { jid, mode, error: (error as Error).message })
				throw error
			}
		},
		communityJoinApprovalMode: async (jid: string, mode: 'on' | 'off') => {
			trace('communities', 'communityJoinApprovalMode:enter', { jid, mode })
			try {
				await communityQuery(jid, 'set', [
					{ tag: 'membership_approval_mode', attrs: {}, content: [{ tag: 'community_join', attrs: { state: mode } }] }
				])
				trace('communities', 'communityJoinApprovalMode:return', { jid, mode })
			} catch (error) {
				trace('communities', 'communityJoinApprovalMode:error', { jid, mode, error: (error as Error).message })
				throw error
			}
		},
		communityFetchAllParticipating
	}
}

export const extractCommunityMetadata = (result: BinaryNode) => {
	trace('communities', 'extractCommunityMetadata:enter')
	const community = getBinaryNodeChild(result, 'community')!
	const descChild = getBinaryNodeChild(community, 'description')
	let desc: string | undefined
	let descId: string | undefined
	if (descChild) {
		desc = getBinaryNodeChildString(descChild, 'body')
		descId = descChild.attrs.id
	}

	const communityId = community.attrs.id?.includes('@')
		? community.attrs.id
		: jidEncode(community.attrs.id || '', 'g.us')
	const eph = getBinaryNodeChild(community, 'ephemeral')?.attrs.expiration
	const memberAddMode = getBinaryNodeChildString(community, 'member_add_mode') === 'all_member_add'
	const metadata: GroupMetadata = {
		id: communityId,
		subject: community.attrs.subject || '',
		subjectOwner: community.attrs.s_o,
		subjectTime: Number(community.attrs.s_t || 0),
		size: getBinaryNodeChildren(community, 'participant').length,
		creation: Number(community.attrs.creation || 0),
		owner: community.attrs.creator ? jidNormalizedUser(community.attrs.creator) : undefined,
		desc,
		descId,
		linkedParent: getBinaryNodeChild(community, 'linked_parent')?.attrs.jid || undefined,
		restrict: !!getBinaryNodeChild(community, 'locked'),
		announce: !!getBinaryNodeChild(community, 'announcement'),
		isCommunity: !!getBinaryNodeChild(community, 'parent'),
		isCommunityAnnounce: !!getBinaryNodeChild(community, 'default_sub_community'),
		joinApprovalMode: !!getBinaryNodeChild(community, 'membership_approval_mode'),
		memberAddMode,
		participants: getBinaryNodeChildren(community, 'participant').map(({ attrs }) => {
			return {
				id: attrs.jid!,
				admin: (attrs.type || null) as GroupParticipant['admin']
			}
		}),
		ephemeralDuration: eph ? +eph : undefined,
		addressingMode: getBinaryNodeChildString(community, 'addressing_mode')! as GroupMetadata['addressingMode']
	}
	trace('communities', 'extractCommunityMetadata:return', { id: metadata.id, size: metadata.size })
	return metadata
}