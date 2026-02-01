import { promisify } from 'util'
import { inflate } from 'zlib'
import { proto } from '../../WAProto/index.js'
import type { Chat, Contact, LIDMapping, WAMessage } from '../Types'
import { WAMessageStubType } from '../Types'
import { isHostedLidUser, isHostedPnUser, isLidUser, isPnUser } from '../WABinary'
import { toNumber } from './generics'
import type { ILogger } from './logger.js'
import { normalizeMessageContent } from './messages'
import { downloadContentFromMessage } from './messages-media'
import { trace } from './trace-logger'

const inflatePromise = promisify(inflate)

const extractPnFromMessages = (messages: proto.IHistorySyncMsg[]): string | undefined => {
	for (const msgItem of messages) {
		const message = msgItem.message
		// Only extract from outgoing messages (fromMe: true) in 1:1 chats
		// because userReceipt.userJid is the recipient's JID
		if (!message?.key?.fromMe || !message.userReceipt?.length) {
			continue
		}

		const userJid = message.userReceipt[0]?.userJid
		if (userJid && (isPnUser(userJid) || isHostedPnUser(userJid))) {
			return userJid
		}
	}

	return undefined
}

export const downloadHistory = async (msg: proto.Message.IHistorySyncNotification, options: RequestInit) => {
	trace('history', 'downloadHistory:enter', { syncType: msg.syncType })
	const stream = await downloadContentFromMessage(msg, 'md-msg-hist', { options })
	const bufferArray: Buffer[] = []
	for await (const chunk of stream) {
		bufferArray.push(chunk)
	}

	let buffer: Buffer = Buffer.concat(bufferArray)

	// decompress buffer
	buffer = await inflatePromise(buffer)

	const syncData = proto.HistorySync.decode(buffer)
	trace('history', 'downloadHistory:return', { conversationsCount: syncData.conversations?.length })
	return syncData
}

export const processHistoryMessage = (item: proto.IHistorySync, logger?: ILogger) => {
	trace('history', 'processHistoryMessage:enter', { syncType: item.syncType, progress: item.progress })
	const messages: WAMessage[] = []
	const contacts: Contact[] = []
	const chats: Chat[] = []
	const lidPnMappings: LIDMapping[] = []

	logger?.trace({ progress: item.progress }, 'processing history of type ' + item.syncType?.toString())

	// Extract LID-PN mappings for all sync types
	for (const m of item.phoneNumberToLidMappings || []) {
		if (m.lidJid && m.pnJid) {
			lidPnMappings.push({ lid: m.lidJid, pn: m.pnJid })
		}
	}

	const syncType = item.syncType
	switch (syncType) {
		case proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP:
		case proto.HistorySync.HistorySyncType.RECENT:
		case proto.HistorySync.HistorySyncType.FULL:
		case proto.HistorySync.HistorySyncType.ON_DEMAND:
			trace('history', 'processHistoryMessage:conversations', { conversationsCount: item.conversations?.length })
			for (const chat of item.conversations! as Chat[]) {
				contacts.push({
					id: chat.id!,
					name: chat.displayName || chat.name || chat.username || undefined,
					lid: chat.lidJid || chat.accountLid || undefined,
					phoneNumber: chat.pnJid || undefined
				})

				const chatId = chat.id!
				const isLid = isLidUser(chatId) || isHostedLidUser(chatId)
				const isPn = isPnUser(chatId) || isHostedPnUser(chatId)
				if (isLid && chat.pnJid) {
					lidPnMappings.push({ lid: chatId, pn: chat.pnJid })
				} else if (isPn && chat.lidJid) {
					lidPnMappings.push({ lid: chat.lidJid, pn: chatId })
				} else if (isLid && !chat.pnJid) {
					// Fallback: extract PN from userReceipt in messages when pnJid is missing
					const pnFromReceipt = extractPnFromMessages(chat.messages || [])
					if (pnFromReceipt) {
						lidPnMappings.push({ lid: chatId, pn: pnFromReceipt })
					}
				}

				const msgs = chat.messages || []
				delete chat.messages

				for (const item of msgs) {
					const message = item.message! as WAMessage
					messages.push(message)

					if (!chat.messages?.length) {
						// keep only the most recent message in the chat array
						chat.messages = [{ message }]
					}

					if (!message.key.fromMe && !chat.lastMessageRecvTimestamp) {
						chat.lastMessageRecvTimestamp = toNumber(message.messageTimestamp)
					}

					if (
						(message.messageStubType === WAMessageStubType.BIZ_PRIVACY_MODE_TO_BSP ||
							message.messageStubType === WAMessageStubType.BIZ_PRIVACY_MODE_TO_FB) &&
						message.messageStubParameters?.[0]
					) {
						contacts.push({
							id: message.key.participant || message.key.remoteJid!,
							verifiedName: message.messageStubParameters?.[0]
						})
					}
				}

				chats.push({ ...chat })
			}

			break
		case proto.HistorySync.HistorySyncType.PUSH_NAME:
			trace('history', 'processHistoryMessage:pushname', { count: item.pushnames?.length })
			for (const c of item.pushnames!) {
				contacts.push({ id: c.id!, notify: c.pushname! })
			}

			break
	}

	const result = {
		chats,
		contacts,
		messages,
		lidPnMappings,
		syncType: item.syncType,
		progress: item.progress
	}
	trace('history', 'processHistoryMessage:return', { chatsCount: chats.length, contactsCount: contacts.length, messagesCount: messages.length, mappingsCount: lidPnMappings.length })
	return result
}

export const downloadAndProcessHistorySyncNotification = async (
	msg: proto.Message.IHistorySyncNotification,
	options: RequestInit,
	logger?: ILogger
) => {
	trace('history', 'downloadAndProcessHistorySyncNotification:enter', { syncType: msg.syncType })
	let historyMsg: proto.HistorySync
	if (msg.initialHistBootstrapInlinePayload) {
		historyMsg = proto.HistorySync.decode(await inflatePromise(msg.initialHistBootstrapInlinePayload))
	} else {
		historyMsg = await downloadHistory(msg, options)
	}

	const result = processHistoryMessage(historyMsg, logger)
	trace('history', 'downloadAndProcessHistorySyncNotification:return', { syncType: result.syncType })
	return result
}

export const getHistoryMsg = (message: proto.IMessage) => {
	const normalizedContent = !!message ? normalizeMessageContent(message) : undefined
	const anyHistoryMsg = normalizedContent?.protocolMessage?.historySyncNotification!
	return anyHistoryMsg
}