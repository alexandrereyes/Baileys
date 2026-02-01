import type { NewsletterCreateResponse, SocketConfig, WAMediaUpload } from '../Types'
import type { NewsletterMetadata, NewsletterUpdate } from '../Types'
import { QueryIds, XWAPaths } from '../Types'
import { generateProfilePicture } from '../Utils/messages-media'
import { getBinaryNodeChild } from '../WABinary'
import { makeGroupsSocket } from './groups'
import { executeWMexQuery as genericExecuteWMexQuery } from './mex'
import { trace } from '../Utils/trace-logger'

const parseNewsletterCreateResponse = (response: NewsletterCreateResponse): NewsletterMetadata => {
	trace('newsletter', 'parseNewsletterCreateResponse:enter', { id: response.id })
	const { id, thread_metadata: thread, viewer_metadata: viewer } = response
	const result = {
		id: id,
		owner: undefined,
		name: thread.name.text,
		creation_time: parseInt(thread.creation_time, 10),
		description: thread.description.text,
		invite: thread.invite,
		subscribers: parseInt(thread.subscribers_count, 10),
		verification: thread.verification,
		picture: {
			id: thread.picture.id,
			directPath: thread.picture.direct_path
		},
		mute_state: viewer.mute
	}
	trace('newsletter', 'parseNewsletterCreateResponse:return', { id, subscribers: result.subscribers })
	return result
}

const parseNewsletterMetadata = (result: unknown): NewsletterMetadata | null => {
	trace('newsletter', 'parseNewsletterMetadata:enter', { hasResult: result !== null })
	if (typeof result !== 'object' || result === null) {
		trace('newsletter', 'parseNewsletterMetadata:return-null', { reason: 'not-object-or-null' })
		return null
	}

	if ('id' in result && typeof result.id === 'string') {
		trace('newsletter', 'parseNewsletterMetadata:return', { id: (result as NewsletterMetadata).id })
		return result as NewsletterMetadata
	}

	if ('result' in result && typeof result.result === 'object' && result.result !== null && 'id' in result.result) {
		const meta = result.result as NewsletterMetadata
		trace('newsletter', 'parseNewsletterMetadata:return-from-nested', { id: meta.id })
		return meta
	}

	trace('newsletter', 'parseNewsletterMetadata:return-null', { reason: 'no-id-field' })
	return null
}

export const makeNewsletterSocket = (config: SocketConfig) => {
	trace('newsletter', 'makeNewsletterSocket:enter')
	const sock = makeGroupsSocket(config)
	const { query, generateMessageTag } = sock

	const executeWMexQuery = <T>(variables: Record<string, unknown>, queryId: string, dataPath: string): Promise<T> => {
		trace('newsletter', 'executeWMexQuery:enter', { queryId, dataPath, variableKeys: Object.keys(variables) })
		return genericExecuteWMexQuery<T>(variables, queryId, dataPath, query, generateMessageTag)
	}

	const newsletterUpdate = async (jid: string, updates: NewsletterUpdate) => {
		trace('newsletter', 'newsletterUpdate:enter', { jid, updateKeys: Object.keys(updates) })
		const variables = {
			newsletter_id: jid,
			updates: {
				...updates,
				settings: null
			}
		}
		const result = await executeWMexQuery(variables, QueryIds.UPDATE_METADATA, 'xwa2_newsletter_update')
		trace('newsletter', 'newsletterUpdate:return', { jid })
		return result
	}

	trace('newsletter', 'makeNewsletterSocket:return')
	return {
		...sock,
		newsletterCreate: async (name: string, description?: string): Promise<NewsletterMetadata> => {
			trace('newsletter', 'newsletterCreate:enter', { name, hasDescription: !!description })
			try {
				const variables = {
					input: {
						name,
						description: description ?? null
					}
				}
				const rawResponse = await executeWMexQuery<NewsletterCreateResponse>(
					variables,
					QueryIds.CREATE,
					XWAPaths.xwa2_newsletter_create
				)
				const result = parseNewsletterCreateResponse(rawResponse)
				trace('newsletter', 'newsletterCreate:return', { id: result.id })
				return result
			} catch (error) {
				trace('newsletter', 'newsletterCreate:error', { error: (error as Error).message })
				throw error
			}
		},

		newsletterUpdate,

		newsletterSubscribers: async (jid: string) => {
			trace('newsletter', 'newsletterSubscribers:enter', { jid })
			try {
				const result = await executeWMexQuery<{ subscribers: number }>(
					{ newsletter_id: jid },
					QueryIds.SUBSCRIBERS,
					XWAPaths.xwa2_newsletter_subscribers
				)
				trace('newsletter', 'newsletterSubscribers:return', { jid, subscribers: result.subscribers })
				return result
			} catch (error) {
				trace('newsletter', 'newsletterSubscribers:error', { error: (error as Error).message })
				throw error
			}
		},

		newsletterMetadata: async (type: 'invite' | 'jid', key: string) => {
			trace('newsletter', 'newsletterMetadata:enter', { type, key })
			try {
				const variables = {
					fetch_creation_time: true,
					fetch_full_image: true,
					fetch_viewer_metadata: true,
					input: {
						key,
						type: type.toUpperCase()
					}
				}
				const result = await executeWMexQuery<unknown>(variables, QueryIds.METADATA, XWAPaths.xwa2_newsletter_metadata)
				const metadata = parseNewsletterMetadata(result)
				trace('newsletter', 'newsletterMetadata:return', { type, hasMetadata: metadata !== null })
				return metadata
			} catch (error) {
				trace('newsletter', 'newsletterMetadata:error', { error: (error as Error).message })
				throw error
			}
		},

		newsletterFollow: (jid: string) => {
			trace('newsletter', 'newsletterFollow:enter', { jid })
			return executeWMexQuery({ newsletter_id: jid }, QueryIds.FOLLOW, XWAPaths.xwa2_newsletter_follow)
		},

		newsletterUnfollow: (jid: string) => {
			trace('newsletter', 'newsletterUnfollow:enter', { jid })
			return executeWMexQuery({ newsletter_id: jid }, QueryIds.UNFOLLOW, XWAPaths.xwa2_newsletter_unfollow)
		},

		newsletterMute: (jid: string) => {
			trace('newsletter', 'newsletterMute:enter', { jid })
			return executeWMexQuery({ newsletter_id: jid }, QueryIds.MUTE, XWAPaths.xwa2_newsletter_mute_v2)
		},

		newsletterUnmute: (jid: string) => {
			trace('newsletter', 'newsletterUnmute:enter', { jid })
			return executeWMexQuery({ newsletter_id: jid }, QueryIds.UNMUTE, XWAPaths.xwa2_newsletter_unmute_v2)
		},

		newsletterUpdateName: async (jid: string, name: string) => {
			trace('newsletter', 'newsletterUpdateName:enter', { jid, name })
			try {
				const result = await newsletterUpdate(jid, { name })
				trace('newsletter', 'newsletterUpdateName:return')
				return result
			} catch (error) {
				trace('newsletter', 'newsletterUpdateName:error', { error: (error as Error).message })
				throw error
			}
		},

		newsletterUpdateDescription: async (jid: string, description: string) => {
			trace('newsletter', 'newsletterUpdateDescription:enter', { jid, description })
			try {
				const result = await newsletterUpdate(jid, { description })
				trace('newsletter', 'newsletterUpdateDescription:return')
				return result
			} catch (error) {
				trace('newsletter', 'newsletterUpdateDescription:error', { error: (error as Error).message })
				throw error
			}
		},

		newsletterUpdatePicture: async (jid: string, content: WAMediaUpload) => {
			trace('newsletter', 'newsletterUpdatePicture:enter', { jid })
			try {
				const { img } = await generateProfilePicture(content)
				const result = await newsletterUpdate(jid, { picture: img.toString('base64') })
				trace('newsletter', 'newsletterUpdatePicture:return', { jid })
				return result
			} catch (error) {
				trace('newsletter', 'newsletterUpdatePicture:error', { error: (error as Error).message })
				throw error
			}
		},

		newsletterRemovePicture: async (jid: string) => {
			trace('newsletter', 'newsletterRemovePicture:enter', { jid })
			try {
				const result = await newsletterUpdate(jid, { picture: '' })
				trace('newsletter', 'newsletterRemovePicture:return', { jid })
				return result
			} catch (error) {
				trace('newsletter', 'newsletterRemovePicture:error', { error: (error as Error).message })
				throw error
			}
		},

		newsletterReactMessage: async (jid: string, serverId: string, reaction?: string) => {
			trace('newsletter', 'newsletterReactMessage:enter', { jid, serverId, hasReaction: !!reaction })
			try {
				const tag = generateMessageTag()
				await query({
					tag: 'message',
					attrs: {
						to: jid,
						...(reaction ? {} : { edit: '7' }),
						type: 'reaction',
						server_id: serverId,
						id: tag
					},
					content: [
						{
							tag: 'reaction',
							attrs: reaction ? { code: reaction } : {}
						}
					]
				})
				trace('newsletter', 'newsletterReactMessage:return')
			} catch (error) {
				trace('newsletter', 'newsletterReactMessage:error', { error: (error as Error).message })
				throw error
			}
		},

		newsletterFetchMessages: async (jid: string, count: number, since: number, after: number) => {
			trace('newsletter', 'newsletterFetchMessages:enter', { jid, count, since, after })
			try {
				const messageUpdateAttrs: { count: string; since?: string; after?: string } = {
					count: count.toString()
				}
				if (typeof since === 'number') {
					messageUpdateAttrs.since = since.toString()
				}

				if (after) {
					messageUpdateAttrs.after = after.toString()
				}

				const result = await query({
					tag: 'iq',
					attrs: {
						id: generateMessageTag(),
						type: 'get',
						xmlns: 'newsletter',
						to: jid
					},
					content: [
						{
							tag: 'message_updates',
							attrs: messageUpdateAttrs
						}
					]
				})
				trace('newsletter', 'newsletterFetchMessages:return', { jid })
				return result
			} catch (error) {
				trace('newsletter', 'newsletterFetchMessages:error', { error: (error as Error).message })
				throw error
			}
		},

		subscribeNewsletterUpdates: async (jid: string): Promise<{ duration: string } | null> => {
			trace('newsletter', 'subscribeNewsletterUpdates:enter', { jid })
			try {
				const result = await query({
					tag: 'iq',
					attrs: {
						id: generateMessageTag(),
						type: 'set',
						xmlns: 'newsletter',
						to: jid
					},
					content: [{ tag: 'live_updates', attrs: {}, content: [] }]
				})
				const liveUpdatesNode = getBinaryNodeChild(result, 'live_updates')
				const duration = liveUpdatesNode?.attrs?.duration
				const hasDuration = duration ? { duration: duration } : null
				trace('newsletter', 'subscribeNewsletterUpdates:return', { jid, hasDuration: !!hasDuration })
				return hasDuration
			} catch (error) {
				trace('newsletter', 'subscribeNewsletterUpdates:error', { error: (error as Error).message })
				throw error
			}
		},

		newsletterAdminCount: async (jid: string): Promise<number> => {
			trace('newsletter', 'newsletterAdminCount:enter', { jid })
			try {
				const response = await executeWMexQuery<{ admin_count: number }>(
					{ newsletter_id: jid },
					QueryIds.ADMIN_COUNT,
					XWAPaths.xwa2_newsletter_admin_count
				)
				trace('newsletter', 'newsletterAdminCount:return', { jid, adminCount: response.admin_count })
				return response.admin_count
			} catch (error) {
				trace('newsletter', 'newsletterAdminCount:error', { error: (error as Error).message })
				throw error
			}
		},

		newsletterChangeOwner: async (jid: string, newOwnerJid: string) => {
			trace('newsletter', 'newsletterChangeOwner:enter', { jid, newOwnerJid })
			try {
				await executeWMexQuery(
					{ newsletter_id: jid, user_id: newOwnerJid },
					QueryIds.CHANGE_OWNER,
					XWAPaths.xwa2_newsletter_change_owner
				)
				trace('newsletter', 'newsletterChangeOwner:return', { jid })
			} catch (error) {
				trace('newsletter', 'newsletterChangeOwner:error', { error: (error as Error).message })
				throw error
			}
		},

		newsletterDemote: async (jid: string, userJid: string) => {
			trace('newsletter', 'newsletterDemote:enter', { jid, userJid })
			try {
				await executeWMexQuery({ newsletter_id: jid, user_id: userJid }, QueryIds.DEMOTE, XWAPaths.xwa2_newsletter_demote)
				trace('newsletter', 'newsletterDemote:return', { jid })
			} catch (error) {
				trace('newsletter', 'newsletterDemote:error', { error: (error as Error).message })
				throw error
			}
		},

		newsletterDelete: async (jid: string) => {
			trace('newsletter', 'newsletterDelete:enter', { jid })
			try {
				await executeWMexQuery({ newsletter_id: jid }, QueryIds.DELETE, XWAPaths.xwa2_newsletter_delete_v2)
				trace('newsletter', 'newsletterDelete:return', { jid })
			} catch (error) {
				trace('newsletter', 'newsletterDelete:error', { error: (error as Error).message })
				throw error
			}
		}
	}
}

export type NewsletterSocket = ReturnType<typeof makeNewsletterSocket>