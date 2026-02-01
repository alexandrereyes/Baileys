import NodeCache from '@cacheable/node-cache'
import { Boom } from '@hapi/boom'
import { proto } from '../../WAProto/index.js'
import { DEFAULT_CACHE_TTLS, PROCESSABLE_HISTORY_TYPES } from '../Defaults'
import type {
	BotListInfo,
	CacheStore,
	ChatModification,
	ChatMutation,
	LTHashState,
	MessageUpsertType,
	PresenceData,
	SocketConfig,
	WABusinessHoursConfig,
	WABusinessProfile,
	WAMediaUpload,
	WAMessage,
	WAPatchCreate,
	WAPatchName,
	WAPresence,
	WAPrivacyCallValue,
	WAPrivacyGroupAddValue,
	WAPrivacyMessagesValue,
	WAPrivacyOnlineValue,
	WAPrivacyValue,
	WAReadReceiptsValue
} from '../Types'
import { ALL_WA_PATCH_NAMES } from '../Types'
import type { QuickReplyAction } from '../Types/Bussines.js'
import type { LabelActionBody } from '../Types/Label'
import { SyncState } from '../Types/State'
import {
	chatModificationToAppPatch,
	type ChatMutationMap,
	decodePatches,
	decodeSyncdSnapshot,
	encodeSyncdPatch,
	extractSyncdPatches,
	generateProfilePicture,
	getHistoryMsg,
	newLTHashState,
	processSyncAction
} from '../Utils'
import { makeMutex } from '../Utils/make-mutex'
import processMessage from '../Utils/process-message'
import { buildTcTokenFromJid } from '../Utils/tc-token-utils'
import {
	type BinaryNode,
	getBinaryNodeChild,
	getBinaryNodeChildren,
	jidDecode,
	jidNormalizedUser,
	reduceBinaryNodeToDictionary,
	S_WHATSAPP_NET
} from '../WABinary'
import { USyncQuery, USyncUser } from '../WAUSync'
import { makeSocket } from './socket.js'
import { trace } from '../Utils/trace-logger'
const MAX_SYNC_ATTEMPTS = 2

export const makeChatsSocket = (config: SocketConfig) => {
	trace('chats', 'makeChatsSocket:ENTRY', {})
	const {
		logger,
		markOnlineOnConnect,
		fireInitQueries,
		appStateMacVerification,
		shouldIgnoreJid,
		shouldSyncHistoryMessage,
		getMessage
	} = config
	const sock = makeSocket(config)
	const {
		ev,
		ws,
		authState,
		generateMessageTag,
		sendNode,
		query,
		signalRepository,
		onUnexpectedError,
		sendUnifiedSession
	} = sock

	let privacySettings: { [_: string]: string } | undefined

	let syncState: SyncState = SyncState.Connecting

	/** this mutex ensures that messages are processed in order */
	const messageMutex = makeMutex()

	/** this mutex ensures that receipts are processed in order */
	const receiptMutex = makeMutex()

	/** this mutex ensures that app state patches are processed in order */
	const appStatePatchMutex = makeMutex()

	/** this mutex ensures that notifications are processed in order */
	const notificationMutex = makeMutex()

	// Timeout for AwaitingInitialSync state
	let awaitingSyncTimeout: NodeJS.Timeout | undefined

	const placeholderResendCache =
		config.placeholderResendCache ||
		(new NodeCache<number>({
			stdTTL: DEFAULT_CACHE_TTLS.MSG_RETRY, // 1 hour
			useClones: false
		}) as CacheStore)

	if (!config.placeholderResendCache) {
		config.placeholderResendCache = placeholderResendCache
	}

	/** helper function to fetch the given app state sync key */
	const getAppStateSyncKey = async (keyId: string) => {
		trace('chats', 'getAppStateSyncKey:ENTRY', { keyId })
		const { [keyId]: key } = await authState.keys.get('app-state-sync-key', [keyId])
		return key
	}

	const fetchPrivacySettings = async (force = false) => {
		trace('chats', 'fetchPrivacySettings:ENTRY', { force })
		if (!privacySettings || force) {
			const { content } = await query({
				tag: 'iq',
				attrs: {
					xmlns: 'privacy',
					to: S_WHATSAPP_NET,
					type: 'get'
				},
				content: [{ tag: 'privacy', attrs: {} }]
			})
			privacySettings = reduceBinaryNodeToDictionary(content?.[0] as BinaryNode, 'category')
		}

		return privacySettings
	}

	/** helper function to run a privacy IQ query */
	const privacyQuery = async (name: string, value: string) => {
		trace('chats', 'privacyQuery:ENTRY', { name, value })
		await query({
			tag: 'iq',
			attrs: {
				xmlns: 'privacy',
				to: S_WHATSAPP_NET,
				type: 'set'
			},
			content: [
				{
					tag: 'privacy',
					attrs: {},
					content: [
						{
							tag: 'category',
							attrs: { name, value }
						}
					]
				}
			]
		})
	}

	const updateMessagesPrivacy = async (value: WAPrivacyMessagesValue) => {
		trace('chats', 'updateMessagesPrivacy:ENTRY', { value })
		await privacyQuery('messages', value)
		trace('chats', 'updateMessagesPrivacy:DONE', { value })
	}

	const updateCallPrivacy = async (value: WAPrivacyCallValue) => {
		trace('chats', 'updateCallPrivacy:ENTRY', { value })
		await privacyQuery('calladd', value)
		trace('chats', 'updateCallPrivacy:DONE', { value })
	}

	const updateLastSeenPrivacy = async (value: WAPrivacyValue) => {
		trace('chats', 'updateLastSeenPrivacy:ENTRY', { value })
		await privacyQuery('last', value)
		trace('chats', 'updateLastSeenPrivacy:DONE', { value })
	}

	const updateOnlinePrivacy = async (value: WAPrivacyOnlineValue) => {
		trace('chats', 'updateOnlinePrivacy:ENTRY', { value })
		await privacyQuery('online', value)
		trace('chats', 'updateOnlinePrivacy:DONE', { value })
	}

	const updateProfilePicturePrivacy = async (value: WAPrivacyValue) => {
		trace('chats', 'updateProfilePicturePrivacy:ENTRY', { value })
		await privacyQuery('profile', value)
		trace('chats', 'updateProfilePicturePrivacy:DONE', { value })
	}

	const updateStatusPrivacy = async (value: WAPrivacyValue) => {
		trace('chats', 'updateStatusPrivacy:ENTRY', { value })
		await privacyQuery('status', value)
		trace('chats', 'updateStatusPrivacy:DONE', { value })
	}

	const updateReadReceiptsPrivacy = async (value: WAReadReceiptsValue) => {
		trace('chats', 'updateReadReceiptsPrivacy:ENTRY', { value })
		await privacyQuery('readreceipts', value)
		trace('chats', 'updateReadReceiptsPrivacy:DONE', { value })
	}

	const updateGroupsAddPrivacy = async (value: WAPrivacyGroupAddValue) => {
		trace('chats', 'updateGroupsAddPrivacy:ENTRY', { value })
		await privacyQuery('groupadd', value)
		trace('chats', 'updateGroupsAddPrivacy:DONE', { value })
	}

	const updateDefaultDisappearingMode = async (duration: number) => {
		trace('chats', 'updateDefaultDisappearingMode:ENTRY', { duration })
		await query({
			tag: 'iq',
			attrs: {
				xmlns: 'disappearing_mode',
				to: S_WHATSAPP_NET,
				type: 'set'
			},
			content: [
				{
					tag: 'disappearing_mode',
					attrs: {
						duration: duration.toString()
					}
				}
			]
		})
		trace('chats', 'updateDefaultDisappearingMode:DONE', { duration })
	}

	const getBotListV2 = async () => {
		trace('chats', 'getBotListV2:ENTRY', {})
		const resp = await query({
			tag: 'iq',
			attrs: {
				xmlns: 'bot',
				to: S_WHATSAPP_NET,
				type: 'get'
			},
			content: [
				{
					tag: 'bot',
					attrs: {
						v: '2'
					}
				}
			]
		})

		const botNode = getBinaryNodeChild(resp, 'bot')

		const botList: BotListInfo[] = []
		for (const section of getBinaryNodeChildren(botNode, 'section')) {
			if (section.attrs.type === 'all') {
				for (const bot of getBinaryNodeChildren(section, 'bot')) {
					botList.push({
						jid: bot.attrs.jid!,
						personaId: bot.attrs['persona_id']!
					})
				}
			}
		}

		trace('chats', 'getBotListV2:DONE', { count: botList.length })
		return botList
	}

	const fetchStatus = async (...jids: string[]) => {
		trace('chats', 'fetchStatus:ENTRY', { jids })
		const usyncQuery = new USyncQuery().withStatusProtocol()

		for (const jid of jids) {
			usyncQuery.withUser(new USyncUser().withId(jid))
		}

		const result = await sock.executeUSyncQuery(usyncQuery)
		trace('chats', 'fetchStatus:DONE', { jids, hasResult: !!result })
		if (result) {
			return result.list
		}
	}

	const fetchDisappearingDuration = async (...jids: string[]) => {
		trace('chats', 'fetchDisappearingDuration:ENTRY', { jids })
		const usyncQuery = new USyncQuery().withDisappearingModeProtocol()

		for (const jid of jids) {
			usyncQuery.withUser(new USyncUser().withId(jid))
		}

		const result = await sock.executeUSyncQuery(usyncQuery)
		trace('chats', 'fetchDisappearingDuration:DONE', { jids, hasResult: !!result })
		if (result) {
			return result.list
		}
	}

	/** update the profile picture for yourself or a group */
	const updateProfilePicture = async (
		jid: string,
		content: WAMediaUpload,
		dimensions?: { width: number; height: number }
	) => {
		trace('chats', 'updateProfilePicture:ENTRY', { jid })
		let targetJid
		if (!jid) {
			throw new Boom(
				'Illegal no-jid profile update. Please specify either your ID or the ID of the chat you wish to update'
			)
		}

		if (jidNormalizedUser(jid) !== jidNormalizedUser(authState.creds.me!.id)) {
			targetJid = jidNormalizedUser(jid) // in case it is someone other than us
		} else {
			targetJid = undefined
		}

		const { img } = await generateProfilePicture(content, dimensions)
		await query({
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				type: 'set',
				xmlns: 'w:profile:picture',
				...(targetJid ? { target: targetJid } : {})
			},
			content: [
				{
					tag: 'picture',
					attrs: { type: 'image' },
					content: img
				}
			]
		})
		trace('chats', 'updateProfilePicture:DONE', { jid, targetJid })
	}

	/** remove the profile picture for yourself or a group */
	const removeProfilePicture = async (jid: string) => {
		trace('chats', 'removeProfilePicture:ENTRY', { jid })
		let targetJid
		if (!jid) {
			throw new Boom(
				'Illegal no-jid profile update. Please specify either your ID or the ID of the chat you wish to update'
			)
		}

		if (jidNormalizedUser(jid) !== jidNormalizedUser(authState.creds.me!.id)) {
			targetJid = jidNormalizedUser(jid) // in case it is someone other than us
		} else {
			targetJid = undefined
		}

		await query({
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				type: 'set',
				xmlns: 'w:profile:picture',
				...(targetJid ? { target: targetJid } : {})
			}
		})
		trace('chats', 'removeProfilePicture:DONE', { jid, targetJid })
	}

	/** update the profile status for yourself */
	const updateProfileStatus = async (status: string) => {
		trace('chats', 'updateProfileStatus:ENTRY', { status })
		await query({
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				type: 'set',
				xmlns: 'status'
			},
			content: [
				{
					tag: 'status',
					attrs: {},
					content: Buffer.from(status, 'utf-8')
				}
			]
		})
		trace('chats', 'updateProfileStatus:DONE', { status })
	}

	const updateProfileName = async (name: string) => {
		trace('chats', 'updateProfileName:ENTRY', { name })
		await chatModify({ pushNameSetting: name }, '')
		trace('chats', 'updateProfileName:DONE', { name })
	}

	const fetchBlocklist = async () => {
		trace('chats', 'fetchBlocklist:ENTRY', {})
		const result = await query({
			tag: 'iq',
			attrs: {
				xmlns: 'blocklist',
				to: S_WHATSAPP_NET,
				type: 'get'
			}
		})

		const listNode = getBinaryNodeChild(result, 'list')
		const jids = getBinaryNodeChildren(listNode, 'item').map(n => n.attrs.jid)
		trace('chats', 'fetchBlocklist:DONE', { count: jids.length })
		return jids
	}

	const updateBlockStatus = async (jid: string, action: 'block' | 'unblock') => {
		trace('chats', 'updateBlockStatus:ENTRY', { jid, action })
		await query({
			tag: 'iq',
			attrs: {
				xmlns: 'blocklist',
				to: S_WHATSAPP_NET,
				type: 'set'
			},
			content: [
				{
					tag: 'item',
					attrs: {
						action,
						jid
					}
				}
			]
		})
		trace('chats', 'updateBlockStatus:DONE', { jid, action })
	}

	const getBusinessProfile = async (jid: string): Promise<WABusinessProfile | void> => {
		trace('chats', 'getBusinessProfile:ENTRY', { jid })
		const results = await query({
			tag: 'iq',
			attrs: {
				to: 's.whatsapp.net',
				xmlns: 'w:biz',
				type: 'get'
			},
			content: [
				{
					tag: 'business_profile',
					attrs: { v: '244' },
					content: [
						{
							tag: 'profile',
							attrs: { jid }
						}
					]
				}
			]
		})

		const profileNode = getBinaryNodeChild(results, 'business_profile')
		const profiles = getBinaryNodeChild(profileNode, 'profile')
		if (profiles) {
			const address = getBinaryNodeChild(profiles, 'address')
			const description = getBinaryNodeChild(profiles, 'description')
			const website = getBinaryNodeChild(profiles, 'website')
			const email = getBinaryNodeChild(profiles, 'email')
			const category = getBinaryNodeChild(getBinaryNodeChild(profiles, 'categories'), 'category')
			const businessHours = getBinaryNodeChild(profiles, 'business_hours')
			const businessHoursConfig = businessHours
				? getBinaryNodeChildren(businessHours, 'business_hours_config')
				: undefined
			const websiteStr = website?.content?.toString()
			const result = {
				wid: profiles.attrs?.jid,
				address: address?.content?.toString(),
				description: description?.content?.toString() || '',
				website: websiteStr ? [websiteStr] : [],
				email: email?.content?.toString(),
				category: category?.content?.toString(),
				business_hours: {
					timezone: businessHours?.attrs?.timezone,
					business_config: businessHoursConfig?.map(({ attrs }) => attrs as unknown as WABusinessHoursConfig)
				}
			}
			trace('chats', 'getBusinessProfile:DONE', { jid, hasProfile: true })
			return result
		}
		trace('chats', 'getBusinessProfile:DONE', { jid, hasProfile: false })
	}

	const cleanDirtyBits = async (type: 'account_sync' | 'groups', fromTimestamp?: number | string) => {
		trace('chats', 'cleanDirtyBits:ENTRY', { type, fromTimestamp })
		logger.info({ fromTimestamp }, 'clean dirty bits ' + type)
		await sendNode({
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				type: 'set',
				xmlns: 'urn:xmpp:whatsapp:dirty',
				id: generateMessageTag()
			},
			content: [
				{
					tag: 'clean',
					attrs: {
						type,
						...(fromTimestamp ? { timestamp: fromTimestamp.toString() } : null)
					}
				}
			]
		})
		trace('chats', 'cleanDirtyBits:DONE', { type })
	}

	const newAppStateChunkHandler = (isInitialSync: boolean) => {
		trace('chats', 'newAppStateChunkHandler:ENTRY', { isInitialSync })
		return {
			onMutation(mutation: ChatMutation) {
				trace('chats', 'newAppStateChunkHandler:onMutation', { isInitialSync, mutation })
				processSyncAction(
					mutation,
					ev,
					authState.creds.me!,
					isInitialSync ? { accountSettings: authState.creds.accountSettings } : undefined,
					logger
				)
				trace('chats', 'newAppStateChunkHandler:onMutation:DONE', { isInitialSync })
			}
		}
	}

	const resyncAppState = ev.createBufferedFunction(
		async (collections: readonly WAPatchName[], isInitialSync: boolean) => {
			trace('chats', 'resyncAppState:ENTRY', { collections, isInitialSync })
			// we use this to determine which events to fire
			// otherwise when we resync from scratch -- all notifications will fire
			const initialVersionMap: { [T in WAPatchName]?: number } = {}
			const globalMutationMap: ChatMutationMap = {}

			await authState.keys.transaction(async () => {
				const collectionsToHandle = new Set<string>(collections)
				// in case something goes wrong -- ensure we don't enter a loop that cannot be exited from
				const attemptsMap: { [T in WAPatchName]?: number } = {}
				// keep executing till all collections are done
				// sometimes a single patch request will not return all the patches (God knows why)
				// so we fetch till they're all done (this is determined by the "has_more_patches" flag)
				while (collectionsToHandle.size) {
					const states = {} as { [T in WAPatchName]: LTHashState }
					const nodes: BinaryNode[] = []

					for (const name of collectionsToHandle as Set<WAPatchName>) {
						const result = await authState.keys.get('app-state-sync-version', [name])
						let state = result[name]

						if (state) {
							if (typeof initialVersionMap[name] === 'undefined') {
								initialVersionMap[name] = state.version
							}
						} else {
							state = newLTHashState()
						}

						states[name] = state

						logger.info(`resyncing ${name} from v${state.version}`)

						nodes.push({
							tag: 'collection',
							attrs: {
								name,
								version: state.version.toString(),
								// return snapshot if being synced from scratch
								return_snapshot: (!state.version).toString()
							}
						})
					}

					const result = await query({
						tag: 'iq',
						attrs: {
							to: S_WHATSAPP_NET,
							xmlns: 'w:sync:app:state',
							type: 'set'
						},
						content: [
							{
								tag: 'sync',
								attrs: {},
								content: nodes
							}
						]
					})

					// extract from binary node
					const decoded = await extractSyncdPatches(result, config?.options)
					for (const key in decoded) {
						const name = key as WAPatchName
						const { patches, hasMorePatches, snapshot } = decoded[name]
						try {
							if (snapshot) {
								const { state: newState, mutationMap } = await decodeSyncdSnapshot(
									name,
									snapshot,
									getAppStateSyncKey,
									initialVersionMap[name],
									appStateMacVerification.snapshot
								)
								states[name] = newState
								Object.assign(globalMutationMap, mutationMap)

								logger.info(`restored state of ${name} from snapshot to v${newState.version} with mutations`)

								await authState.keys.set({ 'app-state-sync-version': { [name]: newState } })
								trace('chats', 'resyncAppState:snapshot:DECODED', { name, version: newState.version })
							}

							// only process if there are syncd patches
							if (patches.length) {
								const { state: newState, mutationMap } = await decodePatches(
									name,
									patches,
									states[name],
									getAppStateSyncKey,
									config.options,
									initialVersionMap[name],
									logger,
									appStateMacVerification.patch
								)

								await authState.keys.set({ 'app-state-sync-version': { [name]: newState } })

								logger.info(`synced ${name} to v${newState.version}`)
								initialVersionMap[name] = newState.version

								Object.assign(globalMutationMap, mutationMap)
								trace('chats', 'resyncAppState:patches:APPLIED', { name, version: newState.version, patchesCount: patches.length })
							}

							if (hasMorePatches) {
								logger.info(`${name} has more patches...`)
							} else {
								// collection is done with sync
								collectionsToHandle.delete(name)
							}
						} catch (error: any) {
							// if retry attempts overshoot
							// or key not found
							const isIrrecoverableError =
								attemptsMap[name]! >= MAX_SYNC_ATTEMPTS ||
								error.output?.statusCode === 404 ||
								error.name === 'TypeError'
							logger.info(
								{ name, error: error.stack },
								`failed to sync state from version${isIrrecoverableError ? '' : ', removing and trying from scratch'}`
							)
							await authState.keys.set({ 'app-state-sync-version': { [name]: null } })
							// increment number of retries
							attemptsMap[name] = (attemptsMap[name] || 0) + 1

							if (isIrrecoverableError) {
								// stop retrying
								collectionsToHandle.delete(name)
							}
						}
					}
				}
			}, authState?.creds?.me?.id || 'resync-app-state')

			const { onMutation } = newAppStateChunkHandler(isInitialSync)
			for (const key in globalMutationMap) {
				onMutation(globalMutationMap[key]!)
			}
			trace('chats', 'resyncAppState:DONE', { collections, isInitialSync, mutationsProcessed: Object.keys(globalMutationMap).length })
		}
	)

	/**
	 * fetch the profile picture of a user/group
	 * type = "preview" for a low res picture
	 * type = "image for the high res picture"
	 */
	const profilePictureUrl = async (jid: string, type: 'preview' | 'image' = 'preview', timeoutMs?: number) => {
		trace('chats', 'profilePictureUrl:ENTRY', { jid, type, timeoutMs })
		const baseContent: BinaryNode[] = [{ tag: 'picture', attrs: { type, query: 'url' } }]

		const tcTokenContent = await buildTcTokenFromJid({ authState, jid, baseContent })

		jid = jidNormalizedUser(jid)
		const result = await query(
			{
				tag: 'iq',
				attrs: {
					target: jid,
					to: S_WHATSAPP_NET,
					type: 'get',
					xmlns: 'w:profile:picture'
				},
				content: tcTokenContent
			},
			timeoutMs
		)
		const child = getBinaryNodeChild(result, 'picture')
		const url = child?.attrs?.url
		trace('chats', 'profilePictureUrl:DONE', { jid, type, hasUrl: !!url })
		return url
	}

	const createCallLink = async (type: 'audio' | 'video', event?: { startTime: number }, timeoutMs?: number) => {
		trace('chats', 'createCallLink:ENTRY', { type, event, timeoutMs })
		const result = await query(
			{
				tag: 'call',
				attrs: {
					id: generateMessageTag(),
					to: '@call'
				},
				content: [
					{
						tag: 'link_create',
						attrs: { media: type },
						content: event ? [{ tag: 'event', attrs: { start_time: String(event.startTime) } }] : undefined
					}
				]
			},
			timeoutMs
		)
		const child = getBinaryNodeChild(result, 'link_create')
		const token = child?.attrs?.token
		trace('chats', 'createCallLink:DONE', { type, hasToken: !!token })
		return token
	}

	const sendPresenceUpdate = async (type: WAPresence, toJid?: string) => {
		trace('chats', 'sendPresenceUpdate:ENTRY', { type, toJid })
		const me = authState.creds.me!
		const isAvailableType = type === 'available'
		if (isAvailableType || type === 'unavailable') {
			if (!me.name) {
				logger.warn('no name present, ignoring presence update request...')
				return
			}

			ev.emit('connection.update', { isOnline: isAvailableType })
			trace('chats', 'sendPresenceUpdate:EMIT', { event: 'connection.update', isOnline: isAvailableType })

			if (isAvailableType) {
				void sendUnifiedSession()
			}

			await sendNode({
				tag: 'presence',
				attrs: {
					name: me.name.replace(/@/g, ''),
					type
				}
			})
		} else {
			const { server } = jidDecode(toJid)!
			const isLid = server === 'lid'

			await sendNode({
				tag: 'chatstate',
				attrs: {
					from: isLid ? me.lid! : me.id,
					to: toJid!
				},
				content: [
					{
						tag: type === 'recording' ? 'composing' : type,
						attrs: type === 'recording' ? { media: 'audio' } : {}
					}
				]
			})
		}
		trace('chats', 'sendPresenceUpdate:DONE', { type, toJid })
	}

	/**
	 * @param toJid the jid to subscribe to
	 * @param tcToken token for subscription, use if present
	 */
	const presenceSubscribe = async (toJid: string) => {
		trace('chats', 'presenceSubscribe:ENTRY', { toJid })
		const tcTokenContent = await buildTcTokenFromJid({ authState, jid: toJid })

		const result = sendNode({
			tag: 'presence',
			attrs: {
				to: toJid,
				id: generateMessageTag(),
				type: 'subscribe'
			},
			content: tcTokenContent
		})
		trace('chats', 'presenceSubscribe:DONE', { toJid })
		return result
	}

	const handlePresenceUpdate = ({ tag, attrs, content }: BinaryNode) => {
		trace('chats', 'handlePresenceUpdate:ENTRY', { tag, attrs, hasContent: Array.isArray(content) })
		let presence: PresenceData | undefined
		const jid = attrs.from
		const participant = attrs.participant || attrs.from

		if (shouldIgnoreJid(jid!) && jid !== S_WHATSAPP_NET) {
			return
		}

		if (tag === 'presence') {
			presence = {
				lastKnownPresence: attrs.type === 'unavailable' ? 'unavailable' : 'available',
				lastSeen: attrs.last && attrs.last !== 'deny' ? +attrs.last : undefined
			}
		} else if (Array.isArray(content)) {
			const [firstChild] = content
			let type = firstChild!.tag as WAPresence
			if (type === 'paused') {
				type = 'available'
			}

			if (firstChild!.attrs?.media === 'audio') {
				type = 'recording'
			}

			presence = { lastKnownPresence: type }
		} else {
			logger.error({ tag, attrs, content }, 'recv invalid presence node')
		}

		if (presence) {
			ev.emit('presence.update', { id: jid!, presences: { [participant!]: presence } })
			trace('chats', 'handlePresenceUpdate:EMIT', { event: 'presence.update', jid, participant })
		}
	}

	const appPatch = async (patchCreate: WAPatchCreate) => {
		trace('chats', 'appPatch:ENTRY', { type: patchCreate.type })
		const name = patchCreate.type
		const myAppStateKeyId = authState.creds.myAppStateKeyId
		if (!myAppStateKeyId) {
			throw new Boom('App state key not present!', { statusCode: 400 })
		}

		let initial: LTHashState
		let encodeResult: { patch: proto.ISyncdPatch; state: LTHashState }

		await appStatePatchMutex.mutex(async () => {
			await authState.keys.transaction(async () => {
				logger.debug({ patch: patchCreate }, 'applying app patch')

				await resyncAppState([name], false)
				trace('chats', 'appPatch:RESYNC_COMPLETE', { name })

				const { [name]: currentSyncVersion } = await authState.keys.get('app-state-sync-version', [name])
				initial = currentSyncVersion || newLTHashState()

				encodeResult = await encodeSyncdPatch(patchCreate, myAppStateKeyId, initial, getAppStateSyncKey)
				const { patch, state } = encodeResult
				trace('chats', 'appPatch:ENCODE_COMPLETE', { name, stateVersion: state.version })

				const node: BinaryNode = {
					tag: 'iq',
					attrs: {
						to: S_WHATSAPP_NET,
						type: 'set',
						xmlns: 'w:sync:app:state'
					},
					content: [
						{
							tag: 'sync',
							attrs: {},
							content: [
								{
									tag: 'collection',
									attrs: {
										name,
										version: (state.version - 1).toString(),
										return_snapshot: 'false'
									},
									content: [
										{
											tag: 'patch',
											attrs: {},
											content: proto.SyncdPatch.encode(patch).finish()
										}
									]
								}
							]
						}
					]
				}
				await query(node)
				trace('chats', 'appPatch:QUERY_COMPLETE', { name })

				await authState.keys.set({ 'app-state-sync-version': { [name]: state } })
			}, authState?.creds?.me?.id || 'app-patch')
		})

		if (config.emitOwnEvents) {
			const { onMutation } = newAppStateChunkHandler(false)
			const { mutationMap } = await decodePatches(
				name,
				[{ ...encodeResult!.patch, version: { version: encodeResult!.state.version } }],
				initial!,
				getAppStateSyncKey,
				config.options,
				undefined,
				logger
			)
			for (const key in mutationMap) {
				onMutation(mutationMap[key]!)
			}
			trace('chats', 'appPatch:EMIT_OWN_EVENTS', { name, mutationsProcessed: Object.keys(mutationMap).length })
		}
		trace('chats', 'appPatch:DONE', { name })
	}

	/** sending non-abt props may fix QR scan fail if server expects */
	const fetchProps = async () => {
		trace('chats', 'fetchProps:ENTRY', {})
		//TODO: implement both protocol 1 and protocol 2 prop fetching, specially for abKey for WM
		const resultNode = await query({
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				xmlns: 'w',
				type: 'get'
			},
			content: [
				{
					tag: 'props',
					attrs: {
						protocol: '2',
						hash: authState?.creds?.lastPropHash || ''
					}
				}
			]
		})

		const propsNode = getBinaryNodeChild(resultNode, 'props')

		let props: { [_: string]: string } = {}
		if (propsNode) {
			if (propsNode.attrs?.hash) {
				// on some clients, the hash is returning as undefined
				authState.creds.lastPropHash = propsNode?.attrs?.hash
				ev.emit('creds.update', authState.creds)
				trace('chats', 'fetchProps:EMIT', { event: 'creds.update' })
			}

			props = reduceBinaryNodeToDictionary(propsNode, 'prop')
		}

		logger.debug('fetched props')

		trace('chats', 'fetchProps:DONE', { propsCount: Object.keys(props).length })
		return props
	}

	/**
	 * modify a chat -- mark unread, read etc.
	 * lastMessages must be sorted in reverse chronologically
	 * requires the last messages till the last message received; required for archive & unread
	 */
	const chatModify = (mod: ChatModification, jid: string) => {
		trace('chats', 'chatModify:ENTRY', { jid, mod })
		const patch = chatModificationToAppPatch(mod, jid)
		return appPatch(patch)
	}

	/**
	 * Enable/Disable link preview privacy, not related to baileys link preview generation
	 */
	const updateDisableLinkPreviewsPrivacy = (isPreviewsDisabled: boolean) => {
		trace('chats', 'updateDisableLinkPreviewsPrivacy:ENTRY', { isPreviewsDisabled })
		return chatModify(
			{
				disableLinkPreviews: { isPreviewsDisabled }
			},
			''
		)
	}

	/**
	 * Star or Unstar a message
	 */
	const star = (jid: string, messages: { id: string; fromMe?: boolean }[], star: boolean) => {
		trace('chats', 'star:ENTRY', { jid, star, messageCount: messages.length })
		return chatModify(
			{
				star: {
					messages,
					star
				}
			},
			jid
		)
	}

	/**
	 * Add or Edit Contact
	 */
	const addOrEditContact = (jid: string, contact: proto.SyncActionValue.IContactAction) => {
		trace('chats', 'addOrEditContact:ENTRY', { jid })
		return chatModify(
			{
				contact
			},
			jid
		)
	}

	/**
	 * Remove Contact
	 */
	const removeContact = (jid: string) => {
		trace('chats', 'removeContact:ENTRY', { jid })
		return chatModify(
			{
				contact: null
			},
			jid
		)
	}

	/**
	 * Adds label
	 */
	const addLabel = (jid: string, labels: LabelActionBody) => {
		trace('chats', 'addLabel:ENTRY', { jid, labels })
		return chatModify(
			{
				addLabel: {
					...labels
				}
			},
			jid
		)
	}

	/**
	 * Adds label for the chats
	 */
	const addChatLabel = (jid: string, labelId: string) => {
		trace('chats', 'addChatLabel:ENTRY', { jid, labelId })
		return chatModify(
			{
				addChatLabel: {
					labelId
				}
			},
			jid
		)
	}

	/**
	 * Removes label for the chat
	 */
	const removeChatLabel = (jid: string, labelId: string) => {
		trace('chats', 'removeChatLabel:ENTRY', { jid, labelId })
		return chatModify(
			{
				removeChatLabel: {
					labelId
				}
			},
			jid
		)
	}

	/**
	 * Adds label for the message
	 */
	const addMessageLabel = (jid: string, messageId: string, labelId: string) => {
		trace('chats', 'addMessageLabel:ENTRY', { jid, messageId, labelId })
		return chatModify(
			{
				addMessageLabel: {
					messageId,
					labelId
				}
			},
			jid
		)
	}

	/**
	 * Removes label for the message
	 */
	const removeMessageLabel = (jid: string, messageId: string, labelId: string) => {
		trace('chats', 'removeMessageLabel:ENTRY', { jid, messageId, labelId })
		return chatModify(
			{
				removeMessageLabel: {
					messageId,
					labelId
				}
			},
			jid
		)
	}

	/**
	 * Add or Edit Quick Reply
	 */
	const addOrEditQuickReply = (quickReply: QuickReplyAction) => {
		trace('chats', 'addOrEditQuickReply:ENTRY', { quickReply })
		return chatModify(
			{
				quickReply
			},
			''
		)
	}

	/**
	 * Remove Quick Reply
	 */
	const removeQuickReply = (timestamp: string) => {
		trace('chats', 'removeQuickReply:ENTRY', { timestamp })
		return chatModify(
			{
				quickReply: { timestamp, deleted: true }
			},
			''
		)
	}

	/**
	 * queries need to be fired on connection open
	 * help ensure parity with WA Web
	 * */
	const executeInitQueries = async () => {
		trace('chats', 'executeInitQueries:ENTRY', {})
		await Promise.all([fetchProps(), fetchBlocklist(), fetchPrivacySettings()])
		trace('chats', 'executeInitQueries:DONE', {})
	}

	const upsertMessage = ev.createBufferedFunction(async (msg: WAMessage, type: MessageUpsertType) => {
		trace('chats', 'upsertMessage:ENTRY', { type, messageId: msg.key.id })
		ev.emit('messages.upsert', { messages: [msg], type })
		trace('chats', 'upsertMessage:EMIT', { event: 'messages.upsert', type, messageId: msg.key.id })

		if (!!msg.pushName) {
			let jid = msg.key.fromMe ? authState.creds.me!.id : msg.key.participant || msg.key.remoteJid
			jid = jidNormalizedUser(jid!)

			if (!msg.key.fromMe) {
				ev.emit('contacts.update', [{ id: jid, notify: msg.pushName, verifiedName: msg.verifiedBizName! }])
				trace('chats', 'upsertMessage:EMIT', { event: 'contacts.update', jid })
			}

			// update our pushname too
			if (msg.key.fromMe && msg.pushName && authState.creds.me?.name !== msg.pushName) {
				ev.emit('creds.update', { me: { ...authState.creds.me!, name: msg.pushName } })
				trace('chats', 'upsertMessage:EMIT', { event: 'creds.update', pushName: msg.pushName })
			}
		}

		const historyMsg = getHistoryMsg(msg.message!)
		const shouldProcessHistoryMsg = historyMsg
			? shouldSyncHistoryMessage(historyMsg) &&
				PROCESSABLE_HISTORY_TYPES.includes(historyMsg.syncType! as proto.HistorySync.HistorySyncType)
			: false

		// State machine: decide on sync and flush
		if (historyMsg && syncState === SyncState.AwaitingInitialSync) {
			if (awaitingSyncTimeout) {
				clearTimeout(awaitingSyncTimeout)
				awaitingSyncTimeout = undefined
			}

			if (shouldProcessHistoryMsg) {
				syncState = SyncState.Syncing
				logger.info('Transitioned to Syncing state')
				trace('chats', 'upsertMessage:STATE_CHANGE', { state: 'Syncing' })
				// Let doAppStateSync handle the final flush after it's done
			} else {
				syncState = SyncState.Online
				logger.info('History sync skipped, transitioning to Online state and flushing buffer')
				ev.flush()
				trace('chats', 'upsertMessage:STATE_CHANGE', { state: 'Online' })
			}
		}

		const doAppStateSync = async () => {
			trace('chats', 'doAppStateSync:ENTRY', { syncState })
			if (syncState === SyncState.Syncing) {
				logger.info('Doing app state sync')
				await resyncAppState(ALL_WA_PATCH_NAMES, true)

				// Sync is complete, go online and flush everything
				syncState = SyncState.Online
				logger.info('App state sync complete, transitioning to Online state and flushing buffer')
				ev.flush()

				const accountSyncCounter = (authState.creds.accountSyncCounter || 0) + 1
				ev.emit('creds.update', { accountSyncCounter })
				trace('chats', 'upsertMessage:EMIT', { event: 'creds.update', accountSyncCounter })
			}
			trace('chats', 'doAppStateSync:DONE', { syncState })
		}

		await Promise.all([
			(async () => {
				if (shouldProcessHistoryMsg) {
					await doAppStateSync()
				}
			})(),
			processMessage(msg, {
				signalRepository,
				shouldProcessHistoryMsg,
				placeholderResendCache,
				ev,
				creds: authState.creds,
				keyStore: authState.keys,
				logger,
				options: config.options,
				getMessage
			})
		])

		// If the app state key arrives and we are waiting to sync, trigger the sync now.
		if (msg.message?.protocolMessage?.appStateSyncKeyShare && syncState === SyncState.Syncing) {
			logger.info('App state sync key arrived, triggering app state sync')
			await doAppStateSync()
		}
		trace('chats', 'upsertMessage:DONE', { type, messageId: msg.key.id })
	})

	ws.on('CB:presence', handlePresenceUpdate)
	ws.on('CB:chatstate', handlePresenceUpdate)

	ws.on('CB:ib,,dirty', async (node: BinaryNode) => {
		const { attrs } = getBinaryNodeChild(node, 'dirty')!
		const type = attrs.type
		trace('chats', 'CB:dirty:RECEIVED', { type })
		switch (type) {
			case 'account_sync':
				if (attrs.timestamp) {
					let { lastAccountSyncTimestamp } = authState.creds
					if (lastAccountSyncTimestamp) {
						await cleanDirtyBits('account_sync', lastAccountSyncTimestamp)
					}

					lastAccountSyncTimestamp = +attrs.timestamp
					ev.emit('creds.update', { lastAccountSyncTimestamp })
					trace('chats', 'CB:dirty:EMIT', { event: 'creds.update', lastAccountSyncTimestamp })
				}

				break
			case 'groups':
				// handled in groups.ts
				break
			default:
				logger.info({ node }, 'received unknown sync')
				break
		}
	})

	ev.on('connection.update', ({ connection, receivedPendingNotifications }) => {
		trace('chats', 'connection.update:RECEIVED', { connection, receivedPendingNotifications })
		if (connection === 'open') {
			if (fireInitQueries) {
				executeInitQueries().catch(error => onUnexpectedError(error, 'init queries'))
			}

			sendPresenceUpdate(markOnlineOnConnect ? 'available' : 'unavailable').catch(error =>
				onUnexpectedError(error, 'presence update requests')
			)
		}

		if (!receivedPendingNotifications || syncState !== SyncState.Connecting) {
			return
		}

		syncState = SyncState.AwaitingInitialSync
		logger.info('Connection is now AwaitingInitialSync, buffering events')
		ev.buffer()
		trace('chats', 'connection.update:STATE_CHANGE', { state: 'AwaitingInitialSync' })

		const willSyncHistory = shouldSyncHistoryMessage(
			proto.Message.HistorySyncNotification.create({
				syncType: proto.HistorySync.HistorySyncType.RECENT
			})
		)

		if (!willSyncHistory) {
			logger.info('History sync is disabled by config, not waiting for notification. Transitioning to Online.')
			syncState = SyncState.Online
			setTimeout(() => ev.flush(), 0)
			trace('chats', 'connection.update:STATE_CHANGE', { state: 'Online' })
			return
		}

		logger.info('History sync is enabled, awaiting notification with a 20s timeout.')

		if (awaitingSyncTimeout) {
			clearTimeout(awaitingSyncTimeout)
		}

		awaitingSyncTimeout = setTimeout(() => {
			if (syncState === SyncState.AwaitingInitialSync) {
				// TODO: investigate
				logger.warn('Timeout in AwaitingInitialSync, forcing state to Online and flushing buffer')
				syncState = SyncState.Online
				ev.flush()
				trace('chats', 'connection.update:TIMEOUT', { state: 'Online' })
			}
		}, 20_000)
	})

	ev.on('lid-mapping.update', async ({ lid, pn }) => {
		try {
			await signalRepository.lidMapping.storeLIDPNMappings([{ lid, pn }])
		} catch (error) {
			logger.warn({ lid, pn, error }, 'Failed to store LID-PN mapping')
		}
	})

	return {
		...sock,
		createCallLink,
		getBotListV2,
		messageMutex,
		receiptMutex,
		appStatePatchMutex,
		notificationMutex,
		fetchPrivacySettings,
		upsertMessage,
		appPatch,
		sendPresenceUpdate,
		presenceSubscribe,
		profilePictureUrl,
		fetchBlocklist,
		fetchStatus,
		fetchDisappearingDuration,
		updateProfilePicture,
		removeProfilePicture,
		updateProfileStatus,
		updateProfileName,
		updateBlockStatus,
		updateDisableLinkPreviewsPrivacy,
		updateCallPrivacy,
		updateMessagesPrivacy,
		updateLastSeenPrivacy,
		updateOnlinePrivacy,
		updateProfilePicturePrivacy,
		updateStatusPrivacy,
		updateReadReceiptsPrivacy,
		updateGroupsAddPrivacy,
		updateDefaultDisappearingMode,
		getBusinessProfile,
		resyncAppState,
		chatModify,
		cleanDirtyBits,
		addOrEditContact,
		removeContact,
		addLabel,
		addChatLabel,
		removeChatLabel,
		addMessageLabel,
		removeMessageLabel,
		star,
		addOrEditQuickReply,
		removeQuickReply
	}
	trace('chats', 'makeChatsSocket:DONE', {})
}
