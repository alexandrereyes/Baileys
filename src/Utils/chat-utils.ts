import { Boom } from '@hapi/boom'
import { proto } from '../../WAProto/index.js'
import type {
	BaileysEventEmitter,
	Chat,
	ChatModification,
	ChatMutation,
	ChatUpdate,
	Contact,
	InitialAppStateSyncOptions,
	LastMessageList,
	LTHashState,
	WAPatchCreate,
	WAPatchName
} from '../Types'
import {
	type ChatLabelAssociation,
	LabelAssociationType,
	type MessageLabelAssociation
} from '../Types/LabelAssociation'
import { type BinaryNode, getBinaryNodeChild, getBinaryNodeChildren, isJidGroup, jidNormalizedUser } from '../WABinary'
import { aesDecrypt, aesEncrypt, hkdf, hmacSign } from './crypto'
import { toNumber } from './generics'
import type { ILogger } from './logger'
import { LT_HASH_ANTI_TAMPERING } from './lt-hash'
import { downloadContentFromMessage } from './messages-media'
import { emitSyncActionResults, processContactAction } from './sync-action-utils'
import { trace } from './trace-logger'

type FetchAppStateSyncKey = (keyId: string) => Promise<proto.Message.IAppStateSyncKeyData | null | undefined>

export type ChatMutationMap = { [index: string]: ChatMutation }

const mutationKeys = async (keydata: Uint8Array) => {
	trace('chat-utils', 'mutationKeys:enter', { keydataLength: keydata.length })
	const expanded = await hkdf(keydata, 160, { info: 'WhatsApp Mutation Keys' })
	const result = {
		indexKey: expanded.slice(0, 32),
		valueEncryptionKey: expanded.slice(32, 64),
		valueMacKey: expanded.slice(64, 96),
		snapshotMacKey: expanded.slice(96, 128),
		patchMacKey: expanded.slice(128, 160)
	}
	trace('chat-utils', 'mutationKeys:return', {})
	return result
}

const generateMac = (
	operation: proto.SyncdMutation.SyncdOperation,
	data: Buffer,
	keyId: Uint8Array | string,
	key: Buffer
) => {
	trace('chat-utils', 'generateMac:enter', { operation, dataLength: data.length })
	const getKeyData = () => {
		let r: number
		switch (operation) {
			case proto.SyncdMutation.SyncdOperation.SET:
				r = 0x01
				break
			case proto.SyncdMutation.SyncdOperation.REMOVE:
				r = 0x02
				break
		}

		const buff = Buffer.from([r])
		return Buffer.concat([buff, Buffer.from(keyId as string, 'base64')])
	}

	const keyData = getKeyData()

	const last = Buffer.alloc(8) // 8 bytes
	last.set([keyData.length], last.length - 1)

	const total = Buffer.concat([keyData, data, last])
	const hmac = hmacSign(total, key, 'sha512')

	const result = hmac.slice(0, 32)
	trace('chat-utils', 'generateMac:return', { macLength: result.length })
	return result
}

const to64BitNetworkOrder = (e: number) => {
	const buff = Buffer.alloc(8)
	buff.writeUint32BE(e, 4)
	return buff
}

type Mac = { indexMac: Uint8Array; valueMac: Uint8Array; operation: proto.SyncdMutation.SyncdOperation }

const makeLtHashGenerator = ({ indexValueMap, hash }: Pick<LTHashState, 'hash' | 'indexValueMap'>) => {
	indexValueMap = { ...indexValueMap }
	const addBuffs: ArrayBuffer[] = []
	const subBuffs: ArrayBuffer[] = []

	return {
		mix: ({ indexMac, valueMac, operation }: Mac) => {
			const indexMacBase64 = Buffer.from(indexMac).toString('base64')
			const prevOp = indexValueMap[indexMacBase64]
			if (operation === proto.SyncdMutation.SyncdOperation.REMOVE) {
				if (!prevOp) {
					throw new Boom('tried remove, but no previous op', { data: { indexMac, valueMac } })
				}

				// remove from index value mac, since this mutation is erased
				delete indexValueMap[indexMacBase64]
			} else {
				addBuffs.push(new Uint8Array(valueMac).buffer)
				// add this index into the history map
				indexValueMap[indexMacBase64] = { valueMac }
			}

			if (prevOp) {
				subBuffs.push(new Uint8Array(prevOp.valueMac).buffer)
			}
		},
		finish: async () => {
			const hashArrayBuffer = new Uint8Array(hash).buffer
			const result = await LT_HASH_ANTI_TAMPERING.subtractThenAdd(hashArrayBuffer, addBuffs, subBuffs)
			const buffer = Buffer.from(result)

			return {
				hash: buffer,
				indexValueMap
			}
		}
	}
}

const generateSnapshotMac = (lthash: Uint8Array, version: number, name: WAPatchName, key: Buffer) => {
	const total = Buffer.concat([lthash, to64BitNetworkOrder(version), Buffer.from(name, 'utf-8')])
	return hmacSign(total, key, 'sha256')
}

const generatePatchMac = (
	snapshotMac: Uint8Array,
	valueMacs: Uint8Array[],
	version: number,
	type: WAPatchName,
	key: Buffer
) => {
	const total = Buffer.concat([snapshotMac, ...valueMacs, to64BitNetworkOrder(version), Buffer.from(type, 'utf-8')])
	return hmacSign(total, key)
}

export const newLTHashState = (): LTHashState => {
	trace('chat-utils', 'newLTHashState:enter', {})
	const state = { version: 0, hash: Buffer.alloc(128), indexValueMap: {} }
	trace('chat-utils', 'newLTHashState:return', { version: state.version })
	return state
}

export const encodeSyncdPatch = async (
	{ type, index, syncAction, apiVersion, operation }: WAPatchCreate,
	myAppStateKeyId: string,
	state: LTHashState,
	getAppStateSyncKey: FetchAppStateSyncKey
) => {
	trace('chat-utils', 'encodeSyncdPatch:enter', { type, operation, apiVersion })
	const key = !!myAppStateKeyId ? await getAppStateSyncKey(myAppStateKeyId) : undefined
	if (!key) {
		throw new Boom(`myAppStateKey ("${myAppStateKeyId}") not present`, { statusCode: 404 })
	}

	const encKeyId = Buffer.from(myAppStateKeyId, 'base64')

	state = { ...state, indexValueMap: { ...state.indexValueMap } }

	const indexBuffer = Buffer.from(JSON.stringify(index))
	const dataProto = proto.SyncActionData.fromObject({
		index: indexBuffer,
		value: syncAction,
		padding: new Uint8Array(0),
		version: apiVersion
	})
	const encoded = proto.SyncActionData.encode(dataProto).finish()

	const keyValue = await mutationKeys(key.keyData!)

	const encValue = aesEncrypt(encoded, keyValue.valueEncryptionKey)
	const valueMac = generateMac(operation, encValue, encKeyId, keyValue.valueMacKey)
	const indexMac = hmacSign(indexBuffer, keyValue.indexKey)

	// update LT hash
	const generator = makeLtHashGenerator(state)
	generator.mix({ indexMac, valueMac, operation })
	Object.assign(state, await generator.finish())

	state.version += 1

	const snapshotMac = generateSnapshotMac(state.hash, state.version, type, keyValue.snapshotMacKey)

	const patch: proto.ISyncdPatch = {
		patchMac: generatePatchMac(snapshotMac, [valueMac], state.version, type, keyValue.patchMacKey),
		snapshotMac: snapshotMac,
		keyId: { id: encKeyId },
		mutations: [
			{
				operation: operation,
				record: {
					index: {
						blob: indexMac
					},
					value: {
						blob: Buffer.concat([encValue, valueMac])
					},
					keyId: { id: encKeyId }
				}
			}
		]
	}

	const base64Index = indexMac.toString('base64')
	state.indexValueMap[base64Index] = { valueMac }

	trace('chat-utils', 'encodeSyncdPatch:return', { version: state.version })
	return { patch, state }
}

export const decodeSyncdMutations = async (
	msgMutations: (proto.ISyncdMutation | proto.ISyncdRecord)[],
	initialState: LTHashState,
	getAppStateSyncKey: FetchAppStateSyncKey,
	onMutation: (mutation: ChatMutation) => void,
	validateMacs: boolean
) => {
	trace('chat-utils', 'decodeSyncdMutations:enter', { mutationsCount: msgMutations.length, validateMacs })
	const ltGenerator = makeLtHashGenerator(initialState)
	// indexKey used to HMAC sign record.index.blob
	// valueEncryptionKey used to AES-256-CBC encrypt record.value.blob[0:-32]
	// the remaining record.value.blob[0:-32] is the mac, it the HMAC sign of key.keyId + decoded proto data + length of bytes in keyId
	for (const msgMutation of msgMutations) {
		// if it's a syncdmutation, get the operation property
		// otherwise, if it's only a record -- it'll be a SET mutation
		const operation = 'operation' in msgMutation ? msgMutation.operation : proto.SyncdMutation.SyncdOperation.SET
		const record =
			'record' in msgMutation && !!msgMutation.record ? msgMutation.record : (msgMutation as proto.ISyncdRecord)

		const key = await getKey(record.keyId!.id!)
		const content = Buffer.from(record.value!.blob!)
		const encContent = content.slice(0, -32)
		const ogValueMac = content.slice(-32)
		if (validateMacs) {
			const contentHmac = generateMac(operation!, encContent, record.keyId!.id!, key.valueMacKey)
			if (Buffer.compare(contentHmac, ogValueMac) !== 0) {
				throw new Boom('HMAC content verification failed')
			}
		}

		const result = aesDecrypt(encContent, key.valueEncryptionKey)
		const syncAction = proto.SyncActionData.decode(result)

		if (validateMacs) {
			const hmac = hmacSign(syncAction.index!, key.indexKey)
			if (Buffer.compare(hmac, record.index!.blob!) !== 0) {
				throw new Boom('HMAC index verification failed')
			}
		}

		const indexStr = Buffer.from(syncAction.index!).toString()
		onMutation({ syncAction, index: JSON.parse(indexStr) })

		ltGenerator.mix({
			indexMac: record.index!.blob!,
			valueMac: ogValueMac,
			operation: operation!
		})
	}

	const result = await ltGenerator.finish()
	trace('chat-utils', 'decodeSyncdMutations:return', { hashLen: result.hash?.length })
	return result

	async function getKey(keyId: Uint8Array) {
		const base64Key = Buffer.from(keyId).toString('base64')
		const keyEnc = await getAppStateSyncKey(base64Key)
		if (!keyEnc) {
			throw new Boom(`failed to find key "${base64Key}" to decode mutation`, {
				statusCode: 404,
				data: { msgMutations }
			})
		}

		return mutationKeys(keyEnc.keyData!)
	}
}

export const decodeSyncdPatch = async (
	msg: proto.ISyncdPatch,
	name: WAPatchName,
	initialState: LTHashState,
	getAppStateSyncKey: FetchAppStateSyncKey,
	onMutation: (mutation: ChatMutation) => void,
	validateMacs: boolean
) => {
	trace('chat-utils', 'decodeSyncdPatch:enter', { name, version: msg.version?.version, validateMacs })
	if (validateMacs) {
		const base64Key = Buffer.from(msg.keyId!.id!).toString('base64')
		const mainKeyObj = await getAppStateSyncKey(base64Key)
		if (!mainKeyObj) {
			throw new Boom(`failed to find key "${base64Key}" to decode patch`, { statusCode: 404, data: { msg } })
		}

		const mainKey = await mutationKeys(mainKeyObj.keyData!)
		const mutationmacs = msg.mutations!.map(mutation => mutation.record!.value!.blob!.slice(-32))

		const patchMac = generatePatchMac(
			msg.snapshotMac!,
			mutationmacs,
			toNumber(msg.version!.version),
			name,
			mainKey.patchMacKey
		)
		if (Buffer.compare(patchMac, msg.patchMac!) !== 0) {
			throw new Boom('Invalid patch mac')
		}
	}

	const result = await decodeSyncdMutations(msg.mutations!, initialState, getAppStateSyncKey, onMutation, validateMacs)
	trace('chat-utils', 'decodeSyncdPatch:return', { hashLen: result.hash?.length })
	return result
}

export const extractSyncdPatches = async (binaryNode: BinaryNode, options: RequestInit) => {
	trace('chat-utils', 'extractSyncdPatches:enter', {})
	const syncNode = getBinaryNodeChild(binaryNode, 'sync')
	const collectionNodes = getBinaryNodeChildren(syncNode, 'collection')

	const final = {} as {
		[T in WAPatchName]: { patches: proto.ISyncdPatch[]; hasMorePatches: boolean; snapshot?: proto.ISyncdSnapshot }
	}
	await Promise.all(
		collectionNodes.map(async collectionNode => {
			const patchesNode = getBinaryNodeChild(collectionNode, 'patches')

			const patches = getBinaryNodeChildren(patchesNode || collectionNode, 'patch')
			const snapshotNode = getBinaryNodeChild(collectionNode, 'snapshot')

			const syncds: proto.ISyncdPatch[] = []
			const name = collectionNode.attrs.name as WAPatchName

			const hasMorePatches = collectionNode.attrs.has_more_patches === 'true'

			let snapshot: proto.ISyncdSnapshot | undefined = undefined
			if (snapshotNode && !!snapshotNode.content) {
				if (!Buffer.isBuffer(snapshotNode)) {
					snapshotNode.content = Buffer.from(Object.values(snapshotNode.content))
				}

				const blobRef = proto.ExternalBlobReference.decode(snapshotNode.content as Buffer)
				const data = await downloadExternalBlob(blobRef, options)
				snapshot = proto.SyncdSnapshot.decode(data)
			}

			for (let { content } of patches) {
				if (content) {
					if (!Buffer.isBuffer(content)) {
						content = Buffer.from(Object.values(content))
					}

					const syncd = proto.SyncdPatch.decode(content as Uint8Array)
					if (!syncd.version) {
						syncd.version = { version: +collectionNode.attrs.version! + 1 }
					}

					syncds.push(syncd)
				}
			}

			final[name] = { patches: syncds, hasMorePatches, snapshot }
		})
	)

	const result = Object.keys(final).length
	trace('chat-utils', 'extractSyncdPatches:return', { collectionsCount: result })
	return final
}

export const downloadExternalBlob = async (blob: proto.IExternalBlobReference, options: RequestInit) => {
	trace('chat-utils', 'downloadExternalBlob:enter', {})
	const stream = await downloadContentFromMessage(blob, 'md-app-state', { options })
	const bufferArray: Buffer[] = []
	for await (const chunk of stream) {
		bufferArray.push(chunk)
	}

	const result = Buffer.concat(bufferArray)
	trace('chat-utils', 'downloadExternalBlob:return', { length: result.length })
	return result
}

export const downloadExternalPatch = async (blob: proto.IExternalBlobReference, options: RequestInit) => {
	trace('chat-utils', 'downloadExternalPatch:enter', {})
	const buffer = await downloadExternalBlob(blob, options)
	const syncData = proto.SyncdMutations.decode(buffer)
	trace('chat-utils', 'downloadExternalPatch:return', { mutationsCount: syncData.mutations?.length })
	return syncData
}

export const decodeSyncdSnapshot = async (
	name: WAPatchName,
	snapshot: proto.ISyncdSnapshot,
	getAppStateSyncKey: FetchAppStateSyncKey,
	minimumVersionNumber: number | undefined,
	validateMacs = true
) => {
	trace('chat-utils', 'decodeSyncdSnapshot:enter', { name, version: snapshot.version?.version, minimumVersionNumber, validateMacs })
	const newState = newLTHashState()
	newState.version = toNumber(snapshot.version!.version)

	const mutationMap: ChatMutationMap = {}
	const areMutationsRequired = typeof minimumVersionNumber === 'undefined' || newState.version > minimumVersionNumber

	const { hash, indexValueMap } = await decodeSyncdMutations(
		snapshot.records!,
		newState,
		getAppStateSyncKey,
		areMutationsRequired
			? mutation => {
					const index = mutation.syncAction.index?.toString()
					mutationMap[index!] = mutation
				}
			: () => {},
		validateMacs
	)
	newState.hash = hash
	newState.indexValueMap = indexValueMap

	if (validateMacs) {
		const base64Key = Buffer.from(snapshot.keyId!.id!).toString('base64')
		const keyEnc = await getAppStateSyncKey(base64Key)
		if (!keyEnc) {
			throw new Boom(`failed to find key "${base64Key}" to decode mutation`)
		}

		const result = await mutationKeys(keyEnc.keyData!)
		const computedSnapshotMac = generateSnapshotMac(newState.hash, newState.version, name, result.snapshotMacKey)
		if (Buffer.compare(snapshot.mac!, computedSnapshotMac) !== 0) {
			throw new Boom(`failed to verify LTHash at ${newState.version} of ${name} from snapshot`)
		}
	}

	trace('chat-utils', 'decodeSyncdSnapshot:return', { version: newState.version })
	return {
		state: newState,
		mutationMap
	}
}

export const decodePatches = async (
	name: WAPatchName,
	syncds: proto.ISyncdPatch[],
	initial: LTHashState,
	getAppStateSyncKey: FetchAppStateSyncKey,
	options: RequestInit,
	minimumVersionNumber?: number,
	logger?: ILogger,
	validateMacs = true
) => {
	trace('chat-utils', 'decodePatches:enter', { name, patchesCount: syncds.length, minimumVersionNumber, validateMacs })
	const newState: LTHashState = {
		...initial,
		indexValueMap: { ...initial.indexValueMap }
	}

	const mutationMap: ChatMutationMap = {}

	for (const syncd of syncds) {
		const { version, keyId, snapshotMac } = syncd
		if (syncd.externalMutations) {
			logger?.trace({ name, version }, 'downloading external patch')
			const ref = await downloadExternalPatch(syncd.externalMutations, options)
			logger?.debug({ name, version, mutations: ref.mutations.length }, 'downloaded external patch')
			syncd.mutations?.push(...ref.mutations)
		}

		const patchVersion = toNumber(version!.version)

		newState.version = patchVersion
		const shouldMutate = typeof minimumVersionNumber === 'undefined' || patchVersion > minimumVersionNumber

		const decodeResult = await decodeSyncdPatch(
			syncd,
			name,
			newState,
			getAppStateSyncKey,
			shouldMutate
				? mutation => {
						const index = mutation.syncAction.index?.toString()
						mutationMap[index!] = mutation
					}
				: () => {},
			true
		)

		newState.hash = decodeResult.hash
		newState.indexValueMap = decodeResult.indexValueMap

		if (validateMacs) {
			const base64Key = Buffer.from(keyId!.id!).toString('base64')
			const keyEnc = await getAppStateSyncKey(base64Key)
			if (!keyEnc) {
				throw new Boom(`failed to find key "${base64Key}" to decode mutation`)
			}

			const result = await mutationKeys(keyEnc.keyData!)
			const computedSnapshotMac = generateSnapshotMac(newState.hash, newState.version, name, result.snapshotMacKey)
			if (Buffer.compare(snapshotMac!, computedSnapshotMac) !== 0) {
				throw new Boom(`failed to verify LTHash at ${newState.version} of ${name}`)
			}
		}

		// clear memory used up by the mutations
		syncd.mutations = []
	}

	trace('chat-utils', 'decodePatches:return', { version: newState.version, mutationsCount: Object.keys(mutationMap).length })
	return { state: newState, mutationMap }
}

export const chatModificationToAppPatch = (mod: ChatModification, jid: string) => {
	trace('chat-utils', 'chatModificationToAppPatch:enter', { jid })
	const OP = proto.SyncdMutation.SyncdOperation
	const getMessageRange = (lastMessages: LastMessageList) => {
		let messageRange: proto.SyncActionValue.ISyncActionMessageRange
		if (Array.isArray(lastMessages)) {
			const lastMsg = lastMessages[lastMessages.length - 1]
			messageRange = {
				lastMessageTimestamp: lastMsg?.messageTimestamp,
				messages: lastMessages?.length
					? lastMessages.map(m => {
							if (!m.key?.id || !m.key?.remoteJid) {
								throw new Boom('Incomplete key', { statusCode: 400, data: m })
							}

							if (isJidGroup(m.key.remoteJid) && !m.key.fromMe && !m.key.participant) {
								throw new Boom('Expected not from me message to have participant', { statusCode: 400, data: m })
							}

							if (!m.messageTimestamp || !toNumber(m.messageTimestamp)) {
								throw new Boom('Missing timestamp in last message list', { statusCode: 400, data: m })
							}

							if (m.key.participant) {
								m.key.participant = jidNormalizedUser(m.key.participant)
							}

							return m
						})
					: undefined
			}
		} else {
			messageRange = lastMessages
		}

		return messageRange
	}

	let patch: WAPatchCreate
	if ('mute' in mod) {
		trace('chat-utils', 'chatModificationToAppPatch:mute', { jid })
		patch = {
			syncAction: {
				muteAction: {
					muted: !!mod.mute,
					muteEndTimestamp: mod.mute || undefined
				}
			},
			index: ['mute', jid],
			type: 'regular_high',
			apiVersion: 2,
			operation: OP.SET
		}
	} else if ('archive' in mod) {
		trace('chat-utils', 'chatModificationToAppPatch:archive', { jid, archived: mod.archive })
		patch = {
			syncAction: {
				archiveChatAction: {
					archived: !!mod.archive,
					messageRange: getMessageRange(mod.lastMessages)
				}
			},
			index: ['archive', jid],
			type: 'regular_low',
			apiVersion: 3,
			operation: OP.SET
		}
	} else if ('markRead' in mod) {
		trace('chat-utils', 'chatModificationToAppPatch:markRead', { jid, read: mod.markRead })
		patch = {
			syncAction: {
				markChatAsReadAction: {
					read: mod.markRead,
					messageRange: getMessageRange(mod.lastMessages)
				}
			},
			index: ['markChatAsRead', jid],
			type: 'regular_low',
			apiVersion: 3,
			operation: OP.SET
		}
	} else if ('deleteForMe' in mod) {
		const { timestamp, key, deleteMedia } = mod.deleteForMe
		trace('chat-utils', 'chatModificationToAppPatch:deleteForMe', { jid, messageId: key.id })
		patch = {
			syncAction: {
				deleteMessageForMeAction: {
					deleteMedia,
					messageTimestamp: timestamp
				}
			},
			index: ['deleteMessageForMe', jid, key.id!, key.fromMe ? '1' : '0', '0'],
			type: 'regular_high',
			apiVersion: 3,
			operation: OP.SET
		}
	} else if ('clear' in mod) {
		trace('chat-utils', 'chatModificationToAppPatch:clear', { jid })
		patch = {
			syncAction: {
				clearChatAction: {
					messageRange: getMessageRange(mod.lastMessages)
				}
			},
			index: ['clearChat', jid, '1' /*the option here is 0 when keep starred messages is enabled*/, '0'],
			type: 'regular_high',
			apiVersion: 6,
			operation: OP.SET
		}
	} else if ('pin' in mod) {
		trace('chat-utils', 'chatModificationToAppPatch:pin', { jid, pinned: mod.pin })
		patch = {
			syncAction: {
				pinAction: {
					pinned: !!mod.pin
				}
			},
			index: ['pin_v1', jid],
			type: 'regular_low',
			apiVersion: 5,
			operation: OP.SET
		}
	} else if ('contact' in mod) {
		trace('chat-utils', 'chatModificationToAppPatch:contact', { jid })
		patch = {
			syncAction: {
				contactAction: mod.contact || {}
			},
			index: ['contact', jid],
			type: 'critical_unblock_low',
			apiVersion: 2,
			operation: mod.contact ? OP.SET : OP.REMOVE
		}
	} else if ('disableLinkPreviews' in mod) {
		trace('chat-utils', 'chatModificationToAppPatch:disableLinkPreviews', {})
		patch = {
			syncAction: {
				privacySettingDisableLinkPreviewsAction: mod.disableLinkPreviews || {}
			},
			index: ['setting_disableLinkPreviews'],
			type: 'regular',
			apiVersion: 8,
			operation: OP.SET
		}
	} else if ('star' in mod) {
		const key = mod.star.messages[0]!
		trace('chat-utils', 'chatModificationToAppPatch:star', { jid, messageId: key.id, starred: mod.star.star })
		patch = {
			syncAction: {
				starAction: {
					starred: !!mod.star.star
				}
			},
			index: ['star', jid, key.id, key.fromMe ? '1' : '0', '0'],
			type: 'regular_low',
			apiVersion: 2,
			operation: OP.SET
		}
	} else if ('delete' in mod) {
		trace('chat-utils', 'chatModificationToAppPatch:delete', { jid })
		patch = {
			syncAction: {
				deleteChatAction: {
					messageRange: getMessageRange(mod.lastMessages)
				}
			},
			index: ['deleteChat', jid, '1'],
			type: 'regular_high',
			apiVersion: 6,
			operation: OP.SET
		}
	} else if ('pushNameSetting' in mod) {
		trace('chat-utils', 'chatModificationToAppPatch:pushNameSetting', { name: mod.pushNameSetting })
		patch = {
			syncAction: {
				pushNameSetting: {
					name: mod.pushNameSetting
				}
			},
			index: ['setting_pushName'],
			type: 'critical_block',
			apiVersion: 1,
			operation: OP.SET
		}
	} else if ('quickReply' in mod) {
		trace('chat-utils', 'chatModificationToAppPatch:quickReply', { timestamp: mod.quickReply.timestamp })
		patch = {
			syncAction: {
				quickReplyAction: {
					count: 0,
					deleted: mod.quickReply.deleted || false,
					keywords: [],
					message: mod.quickReply.message || '',
					shortcut: mod.quickReply.shortcut || ''
				}
			},
			index: ['quick_reply', mod.quickReply.timestamp || String(Math.floor(Date.now() / 1000))],
			type: 'regular',
			apiVersion: 2,
			operation: OP.SET
		}
	} else if ('addLabel' in mod) {
		trace('chat-utils', 'chatModificationToAppPatch:addLabel', { labelId: mod.addLabel.id })
		patch = {
			syncAction: {
				labelEditAction: {
					name: mod.addLabel.name,
					color: mod.addLabel.color,
					predefinedId: mod.addLabel.predefinedId,
					deleted: mod.addLabel.deleted
				}
			},
			index: ['label_edit', mod.addLabel.id],
			type: 'regular',
			apiVersion: 3,
			operation: OP.SET
		}
	} else if ('addChatLabel' in mod) {
		trace('chat-utils', 'chatModificationToAppPatch:addChatLabel', { jid, labelId: mod.addChatLabel.labelId })
		patch = {
			syncAction: {
				labelAssociationAction: {
					labeled: true
				}
			},
			index: [LabelAssociationType.Chat, mod.addChatLabel.labelId, jid],
			type: 'regular',
			apiVersion: 3,
			operation: OP.SET
		}
	} else if ('removeChatLabel' in mod) {
		trace('chat-utils', 'chatModificationToAppPatch:removeChatLabel', { jid, labelId: mod.removeChatLabel.labelId })
		patch = {
			syncAction: {
				labelAssociationAction: {
					labeled: false
				}
			},
			index: [LabelAssociationType.Chat, mod.removeChatLabel.labelId, jid],
			type: 'regular',
			apiVersion: 3,
			operation: OP.SET
		}
	} else if ('addMessageLabel' in mod) {
		trace('chat-utils', 'chatModificationToAppPatch:addMessageLabel', { jid, labelId: mod.addMessageLabel.labelId, messageId: mod.addMessageLabel.messageId })
		patch = {
			syncAction: {
				labelAssociationAction: {
					labeled: true
				}
			},
			index: [LabelAssociationType.Message, mod.addMessageLabel.labelId, jid, mod.addMessageLabel.messageId, '0', '0'],
			type: 'regular',
			apiVersion: 3,
			operation: OP.SET
		}
	} else if ('removeMessageLabel' in mod) {
		trace('chat-utils', 'chatModificationToAppPatch:removeMessageLabel', { jid, labelId: mod.removeMessageLabel.labelId, messageId: mod.removeMessageLabel.messageId })
		patch = {
			syncAction: {
				labelAssociationAction: {
					labeled: false
				}
			},
			index: [
				LabelAssociationType.Message,
				mod.removeMessageLabel.labelId,
				jid,
				mod.removeMessageLabel.messageId,
				'0',
				'0'
			],
			type: 'regular',
			apiVersion: 3,
			operation: OP.SET
		}
	} else {
		throw new Boom('not supported')
	}

	patch.syncAction.timestamp = Date.now()

	trace('chat-utils', 'chatModificationToAppPatch:return', { type: patch.type, operation: patch.operation })
	return patch
}

export const processSyncAction = (
	syncAction: ChatMutation,
	ev: BaileysEventEmitter,
	me: Contact,
	initialSyncOpts?: InitialAppStateSyncOptions,
	logger?: ILogger
) => {
	trace('chat-utils', 'processSyncAction:enter', { isInitialSync: !!initialSyncOpts })
	const isInitialSync = !!initialSyncOpts
	const accountSettings = initialSyncOpts?.accountSettings

	logger?.trace({ syncAction, initialSync: !!initialSyncOpts }, 'processing sync action')

	const {
		syncAction: { value: action },
		index: [type, id, msgId, fromMe]
	} = syncAction

	if (action?.muteAction) {
		trace('chat-utils', 'processSyncAction:mute', { id })
		ev.emit('chats.update', [
			{
				id,
				muteEndTime: action.muteAction?.muted ? toNumber(action.muteAction.muteEndTimestamp) : null,
				conditional: getChatUpdateConditional(id!, undefined)
			}
		])
	} else if (action?.archiveChatAction || type === 'archive' || type === 'unarchive') {
		trace('chat-utils', 'processSyncAction:archive', { id, type })
		// okay so we've to do some annoying computation here
		// when we're initially syncing the app state
		// there are a few cases we need to handle
		// 1. if the account unarchiveChats setting is true
		//   a. if the chat is archived, and no further messages have been received -- simple, keep archived
		//   b. if the chat was archived, and the user received messages from the other person afterwards
		//		then the chat should be marked unarchved --
		//		we compare the timestamp of latest message from the other person to determine this
		// 2. if the account unarchiveChats setting is false -- then it doesn't matter,
		//	it'll always take an app state action to mark in unarchived -- which we'll get anyway
		const archiveAction = action?.archiveChatAction
		const isArchived = archiveAction ? archiveAction.archived : type === 'archive'
		// // basically we don't need to fire an "archive" update if the chat is being marked unarchvied
		// // this only applies for the initial sync
		// if(isInitialSync && !isArchived) {
		// 	isArchived = false
		// }

		const msgRange = !accountSettings?.unarchiveChats ? undefined : archiveAction?.messageRange
		// logger?.debug({ chat: id, syncAction }, 'message range archive')

		ev.emit('chats.update', [
			{
				id,
				archived: isArchived,
				conditional: getChatUpdateConditional(id!, msgRange)
			}
		])
	} else if (action?.markChatAsReadAction) {
		trace('chat-utils', 'processSyncAction:markRead', { id, read: action.markChatAsReadAction.read })
		const markReadAction = action.markChatAsReadAction
		// basically we don't need to fire an "read" update if the chat is being marked as read
		// because the chat is read by default
		// this only applies for the initial sync
		const isNullUpdate = isInitialSync && markReadAction.read

		ev.emit('chats.update', [
			{
				id,
				unreadCount: isNullUpdate ? null : !!markReadAction?.read ? 0 : -1,
				conditional: getChatUpdateConditional(id!, markReadAction?.messageRange)
			}
		])
	} else if (action?.deleteMessageForMeAction || type === 'deleteMessageForMe') {
		trace('chat-utils', 'processSyncAction:deleteMessageForMe', { id, msgId })
		ev.emit('messages.delete', {
			keys: [
				{
					remoteJid: id,
					id: msgId,
					fromMe: fromMe === '1'
				}
			]
		})
	} else if (action?.contactAction) {
		trace('chat-utils', 'processSyncAction:contact', { id })
		const results = processContactAction(action.contactAction, id, logger)
		emitSyncActionResults(ev, results)
	} else if (action?.pushNameSetting) {
		trace('chat-utils', 'processSyncAction:pushName', { name: action?.pushNameSetting?.name })
		const name = action?.pushNameSetting?.name
		if (name && me?.name !== name) {
			ev.emit('creds.update', { me: { ...me, name } })
		}
	} else if (action?.pinAction) {
		trace('chat-utils', 'processSyncAction:pin', { id, pinned: action.pinAction?.pinned })
		ev.emit('chats.update', [
			{
				id,
				pinned: action.pinAction?.pinned ? toNumber(action.timestamp) : null,
				conditional: getChatUpdateConditional(id!, undefined)
			}
		])
	} else if (action?.unarchiveChatsSetting) {
		trace('chat-utils', 'processSyncAction:unarchiveSettings', { unarchiveChats: action.unarchiveChatsSetting.unarchiveChats })
		const unarchiveChats = !!action.unarchiveChatsSetting.unarchiveChats
		ev.emit('creds.update', { accountSettings: { unarchiveChats } })

		logger?.info(`archive setting updated => '${action.unarchiveChatsSetting.unarchiveChats}'`)
		if (accountSettings) {
			accountSettings.unarchiveChats = unarchiveChats
		}
	} else if (action?.starAction || type === 'star') {
		let starred = action?.starAction?.starred
		if (typeof starred !== 'boolean') {
			starred = syncAction.index[syncAction.index.length - 1] === '1'
		}
		trace('chat-utils', 'processSyncAction:star', { id, msgId, starred })

		ev.emit('messages.update', [
			{
				key: { remoteJid: id, id: msgId, fromMe: fromMe === '1' },
				update: { starred }
			}
		])
	} else if (action?.deleteChatAction || type === 'deleteChat') {
		trace('chat-utils', 'processSyncAction:deleteChat', { id })
		if (!isInitialSync) {
			ev.emit('chats.delete', [id!])
		}
	} else if (action?.labelEditAction) {
		trace('chat-utils', 'processSyncAction:labelEdit', { id })
		const { name, color, deleted, predefinedId } = action.labelEditAction

		ev.emit('labels.edit', {
			id: id!,
			name: name!,
			color: color!,
			deleted: deleted!,
			predefinedId: predefinedId ? String(predefinedId) : undefined
		})
	} else if (action?.labelAssociationAction) {
		trace('chat-utils', 'processSyncAction:labelAssociation', { type, id })
		ev.emit('labels.association', {
			type: action.labelAssociationAction.labeled ? 'add' : 'remove',
			association:
				type === LabelAssociationType.Chat
					? ({
							type: LabelAssociationType.Chat,
							chatId: syncAction.index[2],
							labelId: syncAction.index[1]
						} as ChatLabelAssociation)
					: ({
							type: LabelAssociationType.Message,
							chatId: syncAction.index[2],
							messageId: syncAction.index[3],
							labelId: syncAction.index[1]
						} as MessageLabelAssociation)
		})
	} else if (action?.localeSetting?.locale) {
		trace('chat-utils', 'processSyncAction:locale', { locale: action.localeSetting.locale })
		ev.emit('settings.update', { setting: 'locale', value: action.localeSetting.locale })
	} else if (action?.timeFormatAction) {
		trace('chat-utils', 'processSyncAction:timeFormat', {})
		ev.emit('settings.update', { setting: 'timeFormat', value: action.timeFormatAction })
	} else if (action?.pnForLidChatAction) {
		trace('chat-utils', 'processSyncAction:pnForLid', { id, pnJid: action.pnForLidChatAction.pnJid })
		if (action.pnForLidChatAction.pnJid) {
			ev.emit('lid-mapping.update', { lid: id!, pn: action.pnForLidChatAction.pnJid })
		}
	} else if (action?.privacySettingRelayAllCalls) {
		trace('chat-utils', 'processSyncAction:privacyCalls', {})
		ev.emit('settings.update', {
			setting: 'privacySettingRelayAllCalls',
			value: action.privacySettingRelayAllCalls
		})
	} else if (action?.statusPrivacy) {
		trace('chat-utils', 'processSyncAction:statusPrivacy', {})
		ev.emit('settings.update', { setting: 'statusPrivacy', value: action.statusPrivacy })
	} else if (action?.lockChatAction) {
		trace('chat-utils', 'processSyncAction:lockChat', { id, locked: action.lockChatAction.locked })
		ev.emit('chats.lock', { id: id!, locked: !!action.lockChatAction.locked })
	} else if (action?.privacySettingDisableLinkPreviewsAction) {
		trace('chat-utils', 'processSyncAction:disableLinkPreviews', {})
		ev.emit('settings.update', {
			setting: 'disableLinkPreviews',
			value: action.privacySettingDisableLinkPreviewsAction
		})
	} else if (action?.notificationActivitySettingAction?.notificationActivitySetting) {
		trace('chat-utils', 'processSyncAction:notificationActivity', {})
		ev.emit('settings.update', {
			setting: 'notificationActivitySetting',
			value: action.notificationActivitySettingAction.notificationActivitySetting
		})
	} else if (action?.lidContactAction) {
		trace('chat-utils', 'processSyncAction:lidContact', { id })
		ev.emit('contacts.upsert', [
			{
				id: id!,
				name:
					action.lidContactAction.fullName ||
					action.lidContactAction.firstName ||
					action.lidContactAction.username ||
					undefined,
				lid: id!,
				phoneNumber: undefined
			}
		])
	} else if (action?.privacySettingChannelsPersonalisedRecommendationAction) {
		trace('chat-utils', 'processSyncAction:channelsRecommendation', {})
		ev.emit('settings.update', {
			setting: 'channelsPersonalisedRecommendation',
			value: action.privacySettingChannelsPersonalisedRecommendationAction
		})
	} else {
		logger?.debug({ syncAction, id }, 'unprocessable update')
	}

	function getChatUpdateConditional(
		id: string,
		msgRange: proto.SyncActionValue.ISyncActionMessageRange | null | undefined
	): ChatUpdate['conditional'] {
		return isInitialSync
			? data => {
					const chat = data.historySets.chats[id] || data.chatUpserts[id]
					if (chat) {
						return msgRange ? isValidPatchBasedOnMessageRange(chat, msgRange) : true
					}
				}
			: undefined
	}

	function isValidPatchBasedOnMessageRange(
		chat: Chat,
		msgRange: proto.SyncActionValue.ISyncActionMessageRange | null | undefined
	) {
		const lastMsgTimestamp = Number(msgRange?.lastMessageTimestamp || msgRange?.lastSystemMessageTimestamp || 0)
		const chatLastMsgTimestamp = Number(chat?.lastMessageRecvTimestamp || 0)
		return lastMsgTimestamp >= chatLastMsgTimestamp
	}
	trace('chat-utils', 'processSyncAction:return', {})
}