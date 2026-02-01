import { LRUCache } from 'lru-cache'
import type { proto } from '../../WAProto/index.js'
import type { ILogger } from './logger'
import { trace } from './trace-logger'

/** Number of sent messages to cache in memory for handling retry receipts */
const RECENT_MESSAGES_SIZE = 512

const MESSAGE_KEY_SEPARATOR = '\u0000'

/** Timeout for session recreation - 1 hour */
const RECREATE_SESSION_TIMEOUT = 60 * 60 * 1000 // 1 hour in milliseconds
const PHONE_REQUEST_DELAY = 3000
export interface RecentMessageKey {
	to: string
	id: string
}

export interface RecentMessage {
	message: proto.IMessage
	timestamp: number
}

export interface SessionRecreateHistory {
	[jid: string]: number // timestamp
}

export interface RetryCounter {
	[messageId: string]: number
}

export type PendingPhoneRequest = Record<string, ReturnType<typeof setTimeout>>

export interface RetryStatistics {
	totalRetries: number
	successfulRetries: number
	failedRetries: number
	mediaRetries: number
	sessionRecreations: number
	phoneRequests: number
}

export class MessageRetryManager {
	private recentMessagesMap = new LRUCache<string, RecentMessage>({
		max: RECENT_MESSAGES_SIZE,
		ttl: 5 * 60 * 1000,
		ttlAutopurge: true,
		dispose: (_value: RecentMessage, key: string) => {
			const separatorIndex = key.lastIndexOf(MESSAGE_KEY_SEPARATOR)
			if (separatorIndex > -1) {
				const messageId = key.slice(separatorIndex + MESSAGE_KEY_SEPARATOR.length)
				this.messageKeyIndex.delete(messageId)
			}
		}
	})
	private messageKeyIndex = new Map<string, string>()
	private sessionRecreateHistory = new LRUCache<string, number>({
		ttl: RECREATE_SESSION_TIMEOUT * 2,
		ttlAutopurge: true
	})
	private retryCounters = new LRUCache<string, number>({
		ttl: 15 * 60 * 1000,
		ttlAutopurge: true,
		updateAgeOnGet: true
	}) // 15 minutes TTL
	private pendingPhoneRequests: PendingPhoneRequest = {}
	private readonly maxMsgRetryCount: number = 5
	private statistics: RetryStatistics = {
		totalRetries: 0,
		successfulRetries: 0,
		failedRetries: 0,
		mediaRetries: 0,
		sessionRecreations: 0,
		phoneRequests: 0
	}

	constructor(
		private logger: ILogger,
		maxMsgRetryCount: number
	) {
		this.maxMsgRetryCount = maxMsgRetryCount
		trace('message-retry-manager', 'constructor:enter', { maxMsgRetryCount })
		trace('message-retry-manager', 'constructor:return', {})
	}

	/**
	 * Add a recent message to the cache for retry handling
	 */
	addRecentMessage(to: string, id: string, message: proto.IMessage): void {
		trace('message-retry-manager', 'addRecentMessage:enter', { to, id })
		const key: RecentMessageKey = { to, id }
		const keyStr = this.keyToString(key)

		// Add new message
		this.recentMessagesMap.set(keyStr, {
			message,
			timestamp: Date.now()
		})
		this.messageKeyIndex.set(id, keyStr)

		this.logger.debug(`Added message to retry cache: ${to}/${id}`)
		trace('message-retry-manager', 'addRecentMessage:return', {})
	}

	/**
	 * Get a recent message from the cache
	 */
	getRecentMessage(to: string, id: string): RecentMessage | undefined {
		trace('message-retry-manager', 'getRecentMessage:enter', { to, id })
		const key: RecentMessageKey = { to, id }
		const keyStr = this.keyToString(key)
		const result = this.recentMessagesMap.get(keyStr)
		trace('message-retry-manager', 'getRecentMessage:return', { found: !!result })
		return result
	}

	/**
	 * Check if a session should be recreated based on retry count and history
	 */
	shouldRecreateSession(jid: string, hasSession: boolean): { reason: string; recreate: boolean } {
		trace('message-retry-manager', 'shouldRecreateSession:enter', { jid, hasSession })
		// If we don't have a session, always recreate
		if (!hasSession) {
			this.sessionRecreateHistory.set(jid, Date.now())
			this.statistics.sessionRecreations++
			const result = {
				reason: "we don't have a Signal session with them",
				recreate: true
			}
			trace('message-retry-manager', 'shouldRecreateSession:return', result)
			return result
		}

		const now = Date.now()
		const prevTime = this.sessionRecreateHistory.get(jid)

		// If no previous recreation or it's been more than an hour
		if (!prevTime || now - prevTime > RECREATE_SESSION_TIMEOUT) {
			this.sessionRecreateHistory.set(jid, now)
			this.statistics.sessionRecreations++
			const result = {
				reason: 'retry count > 1 and over an hour since last recreation',
				recreate: true
			}
			trace('message-retry-manager', 'shouldRecreateSession:return', result)
			return result
		}

		const result = { reason: '', recreate: false }
		trace('message-retry-manager', 'shouldRecreateSession:return', result)
		return result
	}

	/**
	 * Increment retry counter for a message
	 */
	incrementRetryCount(messageId: string): number {
		trace('message-retry-manager', 'incrementRetryCount:enter', { messageId })
		this.retryCounters.set(messageId, (this.retryCounters.get(messageId) || 0) + 1)
		this.statistics.totalRetries++
		const count = this.retryCounters.get(messageId)!
		trace('message-retry-manager', 'incrementRetryCount:return', { count })
		return count
	}

	/**
	 * Get retry count for a message
	 */
	getRetryCount(messageId: string): number {
		trace('message-retry-manager', 'getRetryCount:enter', { messageId })
		const count = this.retryCounters.get(messageId) || 0
		trace('message-retry-manager', 'getRetryCount:return', { count })
		return count
	}

	/**
	 * Check if message has exceeded maximum retry attempts
	 */
	hasExceededMaxRetries(messageId: string): boolean {
		trace('message-retry-manager', 'hasExceededMaxRetries:enter', { messageId })
		const count = this.getRetryCount(messageId)
		const exceeded = count >= this.maxMsgRetryCount
		trace('message-retry-manager', 'hasExceededMaxRetries:return', { exceeded, count })
		return exceeded
	}

	/**
	 * Mark retry as successful
	 */
	markRetrySuccess(messageId: string): void {
		trace('message-retry-manager', 'markRetrySuccess:enter', { messageId })
		this.statistics.successfulRetries++
		// Clean up retry counter for successful message
		this.retryCounters.delete(messageId)
		this.cancelPendingPhoneRequest(messageId)
		this.removeRecentMessage(messageId)
		trace('message-retry-manager', 'markRetrySuccess:return', {})
	}

	/**
	 * Mark retry as failed
	 */
	markRetryFailed(messageId: string): void {
		trace('message-retry-manager', 'markRetryFailed:enter', { messageId })
		this.statistics.failedRetries++
		this.retryCounters.delete(messageId)
		this.cancelPendingPhoneRequest(messageId)
		this.removeRecentMessage(messageId)
		trace('message-retry-manager', 'markRetryFailed:return', {})
	}

	/**
	 * Schedule a phone request with delay
	 */
	schedulePhoneRequest(messageId: string, callback: () => void, delay: number = PHONE_REQUEST_DELAY): void {
		trace('message-retry-manager', 'schedulePhoneRequest:enter', { messageId, delay })
		// Cancel any existing request for this message
		this.cancelPendingPhoneRequest(messageId)

		this.pendingPhoneRequests[messageId] = setTimeout(() => {
			delete this.pendingPhoneRequests[messageId]
			this.statistics.phoneRequests++
			callback()
		}, delay)

		this.logger.debug(`Scheduled phone request for message ${messageId} with ${delay}ms delay`)
		trace('message-retry-manager', 'schedulePhoneRequest:return', {})
	}

	/**
	 * Cancel pending phone request
	 */
	cancelPendingPhoneRequest(messageId: string): void {
		trace('message-retry-manager', 'cancelPendingPhoneRequest:enter', { messageId })
		const timeout = this.pendingPhoneRequests[messageId]
		if (timeout) {
			clearTimeout(timeout)
			delete this.pendingPhoneRequests[messageId]
			this.logger.debug(`Cancelled pending phone request for message ${messageId}`)
		}
		trace('message-retry-manager', 'cancelPendingPhoneRequest:return', {})
	}

	private keyToString(key: RecentMessageKey): string {
		return `${key.to}${MESSAGE_KEY_SEPARATOR}${key.id}`
	}

	private removeRecentMessage(messageId: string): void {
		const keyStr = this.messageKeyIndex.get(messageId)
		if (!keyStr) {
			return
		}

		this.recentMessagesMap.delete(keyStr)
		this.messageKeyIndex.delete(messageId)
	}
}