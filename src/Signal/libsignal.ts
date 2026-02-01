/* @ts-ignore */
import * as libsignal from 'libsignal'
import { LRUCache } from 'lru-cache'
import type { LIDMapping, SignalAuthState, SignalKeyStoreWithTransaction } from '../Types'
import type { SignalRepositoryWithLIDStore } from '../Types/Signal'
import { generateSignalPubKey } from '../Utils'
import type { ILogger } from '../Utils/logger'
import { trace } from '../Utils/trace-logger'
import {
	isHostedLidUser,
	isHostedPnUser,
	isLidUser,
	isPnUser,
	jidDecode,
	transferDevice,
	WAJIDDomains
} from '../WABinary'
import type { SenderKeyStore } from './Group/group_cipher'
import { SenderKeyName } from './Group/sender-key-name'
import { SenderKeyRecord } from './Group/sender-key-record'
import { GroupCipher, GroupSessionBuilder, SenderKeyDistributionMessage } from './Group'
import { LIDMappingStore } from './lid-mapping'

export function makeLibSignalRepository(
	auth: SignalAuthState,
	logger: ILogger,
	pnToLIDFunc?: (jids: string[]) => Promise<LIDMapping[] | undefined>
): SignalRepositoryWithLIDStore {
	trace('libsignal', 'makeLibSignalRepository:enter', { hasPnToLIDFunc: !!pnToLIDFunc })
	const lidMapping = new LIDMappingStore(auth.keys as SignalKeyStoreWithTransaction, logger, pnToLIDFunc)
	const storage = signalStorage(auth, lidMapping)

	const parsedKeys = auth.keys as SignalKeyStoreWithTransaction
	const migratedSessionCache = new LRUCache<string, true>({
		ttl: 3 * 24 * 60 * 60 * 1000, // 7 days
		ttlAutopurge: true,
		updateAgeOnGet: true
	})

	const repository: SignalRepositoryWithLIDStore = {
		decryptGroupMessage({ group, authorJid, msg }) {
			trace('libsignal', 'decryptGroupMessage:enter', { group, authorJid, msgLen: msg.length })
			const senderName = jidToSignalSenderKeyName(group, authorJid)
			const cipher = new GroupCipher(storage, senderName)

			// Use transaction to ensure atomicity
			return parsedKeys.transaction(async () => {
				const result = await cipher.decrypt(msg)
				trace('libsignal', 'decryptGroupMessage:return', { plaintextLen: result.length })
				return result
			}, group)
		},
		async processSenderKeyDistributionMessage({ item, authorJid }) {
			trace('libsignal', 'processSenderKeyDistributionMessage:enter', { authorJid, groupId: item.groupId })
			const builder = new GroupSessionBuilder(storage)
			if (!item.groupId) {
				throw new Error('Group ID is required for sender key distribution message')
			}

			const senderName = jidToSignalSenderKeyName(item.groupId, authorJid)

			const senderMsg = new SenderKeyDistributionMessage(
				null,
				null,
				null,
				null,
				item.axolotlSenderKeyDistributionMessage
			)
			const senderNameStr = senderName.toString()
			const { [senderNameStr]: senderKey } = await auth.keys.get('sender-key', [senderNameStr])
			if (!senderKey) {
				await storage.storeSenderKey(senderName, new SenderKeyRecord())
			}

			return parsedKeys.transaction(async () => {
				const { [senderNameStr]: senderKey } = await auth.keys.get('sender-key', [senderNameStr])
				if (!senderKey) {
					await storage.storeSenderKey(senderName, new SenderKeyRecord())
				}

				await builder.process(senderName, senderMsg)
				trace('libsignal', 'processSenderKeyDistributionMessage:complete', { senderName: senderName.toString() })
			}, item.groupId)
		},
		async decryptMessage({ jid, type, ciphertext }) {
			trace('libsignal', 'decryptMessage:enter', { jid, type, ciphertextLen: ciphertext.length })
			const addr = jidToSignalProtocolAddress(jid)
			const session = new libsignal.SessionCipher(storage, addr)

			async function doDecrypt() {
				let result: Uint8Array
				switch (type) {
					case 'pkmsg':
						result = await session.decryptPreKeyWhisperMessage(ciphertext)
						break
					case 'msg':
						result = await session.decryptWhisperMessage(ciphertext)
						break
				}

				trace('libsignal', 'decryptMessage:decrypted', { type, plaintextLen: result.length })
				return result
			}

			// If it's not a sync message, we need to ensure atomicity
			// For regular messages, we use a transaction to ensure atomicity
			return parsedKeys.transaction(async () => {
				return await doDecrypt()
			}, jid)
		},

		async encryptMessage({ jid, data }) {
			trace('libsignal', 'encryptMessage:enter', { jid, dataLen: data.length })
			const addr = jidToSignalProtocolAddress(jid)
			const cipher = new libsignal.SessionCipher(storage, addr)

			// Use transaction to ensure atomicity
			return parsedKeys.transaction(async () => {
				const { type: sigType, body } = await cipher.encrypt(data)
				const type = sigType === 3 ? 'pkmsg' as const : 'msg' as const
				const result = { type, ciphertext: Buffer.from(body, 'binary') }
				trace('libsignal', 'encryptMessage:return', { type, ciphertextLen: result.ciphertext.length })
				return result
			}, jid)
		},

		async encryptGroupMessage({ group, meId, data }) {
			trace('libsignal', 'encryptGroupMessage:enter', { group, meId, dataLen: data.length })
			const senderName = jidToSignalSenderKeyName(group, meId)
			const builder = new GroupSessionBuilder(storage)

			const senderNameStr = senderName.toString()

			return parsedKeys.transaction(async () => {
				const { [senderNameStr]: senderKey } = await auth.keys.get('sender-key', [senderNameStr])
				if (!senderKey) {
					trace('libsignal', 'encryptGroupMessage: creatingSenderKeyRecord', { senderName: senderNameStr })
					await storage.storeSenderKey(senderName, new SenderKeyRecord())
				}

				const senderKeyDistributionMessage = await builder.create(senderName)
				const session = new GroupCipher(storage, senderName)
				const ciphertext = await session.encrypt(data)

				const result = {
					ciphertext,
					senderKeyDistributionMessage: senderKeyDistributionMessage.serialize()
				}
				trace('libsignal', 'encryptGroupMessage:return', { ciphertextLen: ciphertext.length, skdmLen: result.senderKeyDistributionMessage.length })
				return result
			}, group)
		},

		async injectE2ESession({ jid, session }) {
			logger.trace({ jid }, 'injecting E2EE session')
			trace('libsignal', 'injectE2ESession:enter', { jid, registrationId: session.registrationId })
			const cipher = new libsignal.SessionBuilder(storage, jidToSignalProtocolAddress(jid))
			return parsedKeys.transaction(async () => {
				await cipher.initOutgoing(session)
				trace('libsignal', 'injectE2ESession:complete', { jid })
			}, jid)
		},
		jidToSignalProtocolAddress(jid) {
			return jidToSignalProtocolAddress(jid).toString()
		},

		// Optimized direct access to LID mapping store
		lidMapping,

		async validateSession(jid: string) {
			trace('libsignal', 'validateSession:enter', { jid })
			try {
				const addr = jidToSignalProtocolAddress(jid)
				const session = await storage.loadSession(addr.toString())

				if (!session) {
					trace('libsignal', 'validateSession:noSession', { jid })
					return { exists: false, reason: 'no session' }
				}

				if (!session.haveOpenSession()) {
					trace('libsignal', 'validateSession:noOpenSession', { jid })
					return { exists: false, reason: 'no open session' }
				}

				trace('libsignal', 'validateSession:valid', { jid })
				return { exists: true }
			} catch (error) {
				trace('libsignal', 'validateSession:error', { jid, error: String(error) })
				return { exists: false, reason: 'validation error' }
			}
		},

		async deleteSession(jids: string[]) {
			trace('libsignal', 'deleteSession:enter', { jidsCount: jids.length, jids })
			if (!jids.length) return

			// Convert JIDs to signal addresses and prepare for bulk deletion
			const sessionUpdates: { [key: string]: null } = {}
			jids.forEach(jid => {
				const addr = jidToSignalProtocolAddress(jid)
				sessionUpdates[addr.toString()] = null
			})

			// Single transaction for all deletions
			return parsedKeys.transaction(async () => {
				await auth.keys.set({ session: sessionUpdates })
				trace('libsignal', 'deleteSession:complete', { deletedCount: jids.length })
			}, `delete-${jids.length}-sessions`)
		},

		async migrateSession(
			fromJid: string,
			toJid: string
		): Promise<{ migrated: number; skipped: number; total: number }> {
			trace('libsignal', 'migrateSession:enter', { fromJid, toJid })
			// TODO: use usync to handle this entire mess
			if (!fromJid || (!isLidUser(toJid) && !isHostedLidUser(toJid))) {
				trace('libsignal', 'migrateSession:skip-invalid', { fromJid, toJid })
				return { migrated: 0, skipped: 0, total: 0 }
			}

			// Only support PN to LID migration
			if (!isPnUser(fromJid) && !isHostedPnUser(fromJid)) {
				trace('libsignal', 'migrateSession:skip-not-pn', { fromJid })
				return { migrated: 0, skipped: 0, total: 1 }
			}

			const { user } = jidDecode(fromJid)!

			logger.debug({ fromJid }, 'bulk device migration - loading all user devices')

			// Get user's device list from storage
			const { [user]: userDevices } = await parsedKeys.get('device-list', [user])
			if (!userDevices) {
				trace('libsignal', 'migrateSession:noDevices', { user })
				return { migrated: 0, skipped: 0, total: 0 }
			}

			const { device: fromDevice } = jidDecode(fromJid)!
			const fromDeviceStr = fromDevice?.toString() || '0'
			if (!userDevices.includes(fromDeviceStr)) {
				userDevices.push(fromDeviceStr)
			}

			// Filter out cached devices before database fetch
			const uncachedDevices = userDevices.filter(device => {
				const deviceKey = `${user}.${device}`
				return !migratedSessionCache.has(deviceKey)
			})

			// Bulk check session existence only for uncached devices
			const deviceSessionKeys = uncachedDevices.map(device => `${user}.${device}`)
			const existingSessions = await parsedKeys.get('session', deviceSessionKeys)

			// Step 3: Convert existing sessions to JIDs (only migrate sessions that exist)
			const deviceJids: string[] = []
			for (const [sessionKey, sessionData] of Object.entries(existingSessions)) {
				if (sessionData) {
					// Session exists in storage
					const deviceStr = sessionKey.split('.')[1]
					if (!deviceStr) continue
					const deviceNum = parseInt(deviceStr)
					let jid = deviceNum === 0 ? `${user}@s.whatsapp.net` : `${user}:${deviceNum}@s.whatsapp.net`
					if (deviceNum === 99) {
						jid = `${user}:99@hosted`
					}

					deviceJids.push(jid)
				}
			}

			logger.debug(
				{
					fromJid,
					totalDevices: userDevices.length,
					devicesWithSessions: deviceJids.length,
					devices: deviceJids
				},
				'bulk device migration complete - all user devices processed'
			)

			// Single transaction for all migrations
			return parsedKeys.transaction(
				async (): Promise<{ migrated: number; skipped: number; total: number }> => {
					// Prepare migration operations with addressing metadata
					type MigrationOp = {
						fromJid: string
						toJid: string
						pnUser: string
						lidUser: string
						deviceId: number
						fromAddr: libsignal.ProtocolAddress
						toAddr: libsignal.ProtocolAddress
					}

					const migrationOps: MigrationOp[] = deviceJids.map(jid => {
						const lidWithDevice = transferDevice(jid, toJid)
						const fromDecoded = jidDecode(jid)!
						const toDecoded = jidDecode(lidWithDevice)!

						return {
							fromJid: jid,
							toJid: lidWithDevice,
							pnUser: fromDecoded.user,
							lidUser: toDecoded.user,
							deviceId: fromDecoded.device || 0,
							fromAddr: jidToSignalProtocolAddress(jid),
							toAddr: jidToSignalProtocolAddress(lidWithDevice)
						}
					})

					const totalOps = migrationOps.length
					let migratedCount = 0

					// Bulk fetch PN sessions - already exist (verified during device discovery)
					const pnAddrStrings = Array.from(new Set(migrationOps.map(op => op.fromAddr.toString())))
					const pnSessions = await parsedKeys.get('session', pnAddrStrings)

					// Prepare bulk session updates (PN → LID migration + deletion)
					const sessionUpdates: { [key: string]: Uint8Array | null } = {}

					for (const op of migrationOps) {
						const pnAddrStr = op.fromAddr.toString()
						const lidAddrStr = op.toAddr.toString()

						const pnSession = pnSessions[pnAddrStr]
						if (pnSession) {
							// Session exists (guaranteed from device discovery)
							const fromSession = libsignal.SessionRecord.deserialize(pnSession)
							if (fromSession.haveOpenSession()) {
								// Queue for bulk update: copy to LID, delete from PN
								sessionUpdates[lidAddrStr] = fromSession.serialize()
								sessionUpdates[pnAddrStr] = null

								migratedCount++
							}
						}
					}

					// Single bulk session update for all migrations
					if (Object.keys(sessionUpdates).length > 0) {
						await parsedKeys.set({ session: sessionUpdates })
						logger.debug({ migratedSessions: migratedCount }, 'bulk session migration complete')

						// Cache device-level migrations
						for (const op of migrationOps) {
							if (sessionUpdates[op.toAddr.toString()]) {
								const deviceKey = `${op.pnUser}.${op.deviceId}`
								migratedSessionCache.set(deviceKey, true)
							}
						}
					}

					const skippedCount = totalOps - migratedCount
					trace('libsignal', 'migrateSession:result', { fromJid, toJid, migrated: migratedCount, skipped: skippedCount, total: totalOps })
					return { migrated: migratedCount, skipped: skippedCount, total: totalOps }
				},
				`migrate-${deviceJids.length}-sessions-${jidDecode(toJid)?.user}`
			)
		}
	}

	trace('libsignal', 'makeLibSignalRepository:return', { repository })
	return repository
}

const jidToSignalProtocolAddress = (jid: string): libsignal.ProtocolAddress => {
	const decoded = jidDecode(jid)!
	const { user, device, server, domainType } = decoded

	if (!user) {
		throw new Error(
			`JID decoded but user is empty: "${jid}" -> user: "${user}", server: "${server}", device: ${device}`
		)
	}

	const signalUser = domainType !== WAJIDDomains.WHATSAPP ? `${user}_${domainType}` : user
	const finalDevice = device || 0

	if (device === 99 && decoded.server !== 'hosted' && decoded.server !== 'hosted.lid') {
		throw new Error('Unexpected non-hosted device JID with device 99. This ID seems invalid. ID:' + jid)
	}

	return new libsignal.ProtocolAddress(signalUser, finalDevice)
}

const jidToSignalSenderKeyName = (group: string, user: string): SenderKeyName => {
	return new SenderKeyName(group, jidToSignalProtocolAddress(user))
}

function signalStorage(
	{ creds, keys }: SignalAuthState,
	lidMapping: LIDMappingStore
): SenderKeyStore & libsignal.SignalStorage {
	// Shared function to resolve PN signal address to LID if mapping exists
	const resolveLIDSignalAddress = async (id: string): Promise<string> => {
		if (id.includes('.')) {
			const [deviceId, device] = id.split('.')
			const [user, domainType_] = deviceId!.split('_')
			const domainType = parseInt(domainType_ || '0')

			if (domainType === WAJIDDomains.LID || domainType === WAJIDDomains.HOSTED_LID) return id

			const pnJid = `${user!}${device !== '0' ? `:${device}` : ''}@${domainType === WAJIDDomains.HOSTED ? 'hosted' : 's.whatsapp.net'}`

			const lidForPN = await lidMapping.getLIDForPN(pnJid)
			if (lidForPN) {
				const lidAddr = jidToSignalProtocolAddress(lidForPN)
				return lidAddr.toString()
			}
		}

		return id
	}

	return {
		loadSession: async (id: string) => {
			trace('libsignal', 'signalStorage.loadSession:enter', { id })
			try {
				const wireJid = await resolveLIDSignalAddress(id)
				const { [wireJid]: sess } = await keys.get('session', [wireJid])

				if (sess) {
					trace('libsignal', 'signalStorage.loadSession:found', { id, wireJid, sessionLen: sess.length })
					return libsignal.SessionRecord.deserialize(sess)
				}
			} catch (e) {
				trace('libsignal', 'signalStorage.loadSession:error', { id, error: String(e) })
				return null
			}

			trace('libsignal', 'signalStorage.loadSession:notFound', { id })
			return null
		},
		storeSession: async (id: string, session: libsignal.SessionRecord) => {
			trace('libsignal', 'signalStorage.storeSession:enter', { id })
			const wireJid = await resolveLIDSignalAddress(id)
			await keys.set({ session: { [wireJid]: session.serialize() } })
			trace('libsignal', 'signalStorage.storeSession:complete', { id, wireJid })
		},
		isTrustedIdentity: () => {
			return true // todo: implement
		},
		loadPreKey: async (id: number | string) => {
			trace('libsignal', 'signalStorage.loadPreKey:enter', { id })
			const keyId = id.toString()
			const { [keyId]: key } = await keys.get('pre-key', [keyId])
			if (key) {
				trace('libsignal', 'signalStorage.loadPreKey:found', { id })
				return {
					privKey: Buffer.from(key.private),
					pubKey: Buffer.from(key.public)
				}
			}
			trace('libsignal', 'signalStorage.loadPreKey:notFound', { id })
		},
		removePreKey: (id: number) => {
			trace('libsignal', 'signalStorage.removePreKey:enter', { id })
			return keys.set({ 'pre-key': { [id]: null } })
		},
		loadSignedPreKey: () => {
			const key = creds.signedPreKey
			return {
				privKey: Buffer.from(key.keyPair.private),
				pubKey: Buffer.from(key.keyPair.public)
			}
		},
		loadSenderKey: async (senderKeyName: SenderKeyName) => {
			const keyId = senderKeyName.toString()
			trace('libsignal', 'signalStorage.loadSenderKey:enter', { keyId })
			const { [keyId]: key } = await keys.get('sender-key', [keyId])
			if (key) {
				trace('libsignal', 'signalStorage.loadSenderKey:found', { keyId, keyLen: key.length })
				return SenderKeyRecord.deserialize(key)
			}

			trace('libsignal', 'signalStorage.loadSenderKey:notFound-creating', { keyId })
			return new SenderKeyRecord()
		},
		storeSenderKey: async (senderKeyName: SenderKeyName, key: SenderKeyRecord) => {
			const keyId = senderKeyName.toString()
			trace('libsignal', 'signalStorage.storeSenderKey:enter', { keyId })
			const serialized = JSON.stringify(key.serialize())
			await keys.set({ 'sender-key': { [keyId]: Buffer.from(serialized, 'utf-8') } })
			trace('libsignal', 'signalStorage.storeSenderKey:complete', { keyId, serializedLen: serialized.length })
		},
		getOurRegistrationId: () => creds.registrationId,
		getOurIdentity: () => {
			const { signedIdentityKey } = creds
			return {
				privKey: Buffer.from(signedIdentityKey.private),
				pubKey: Buffer.from(generateSignalPubKey(signedIdentityKey.public))
			}
		}
	}
}
