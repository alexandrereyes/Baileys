import * as keyhelper from './keyhelper'
import { SenderKeyDistributionMessage } from './sender-key-distribution-message'
import { SenderKeyName } from './sender-key-name'
import { SenderKeyRecord } from './sender-key-record'
import { trace } from '../../Utils/trace-logger'

interface SenderKeyStore {
	loadSenderKey(senderKeyName: SenderKeyName): Promise<SenderKeyRecord>
	storeSenderKey(senderKeyName: SenderKeyName, record: SenderKeyRecord): Promise<void>
}

export class GroupSessionBuilder {
	private readonly senderKeyStore: SenderKeyStore

	constructor(senderKeyStore: SenderKeyStore) {
		trace('group-session-builder', 'GroupSessionBuilder.constructor')
		this.senderKeyStore = senderKeyStore
	}

	public async process(
		senderKeyName: SenderKeyName,
		senderKeyDistributionMessage: SenderKeyDistributionMessage
	): Promise<void> {
		trace('group-session-builder', 'GroupSessionBuilder.process:enter', {
			senderKeyName: senderKeyName.toString(),
			keyId: senderKeyDistributionMessage.getId(),
			iteration: senderKeyDistributionMessage.getIteration()
		})
		const senderKeyRecord = await this.senderKeyStore.loadSenderKey(senderKeyName)
		senderKeyRecord.addSenderKeyState(
			senderKeyDistributionMessage.getId(),
			senderKeyDistributionMessage.getIteration(),
			senderKeyDistributionMessage.getChainKey(),
			senderKeyDistributionMessage.getSignatureKey()
		)
		await this.senderKeyStore.storeSenderKey(senderKeyName, senderKeyRecord)
		trace('group-session-builder', 'GroupSessionBuilder.process:complete', { senderKeyName: senderKeyName.toString() })
	}

	public async create(senderKeyName: SenderKeyName): Promise<SenderKeyDistributionMessage> {
		trace('group-session-builder', 'GroupSessionBuilder.create:enter', { senderKeyName: senderKeyName.toString() })
		const senderKeyRecord = await this.senderKeyStore.loadSenderKey(senderKeyName)

		if (senderKeyRecord.isEmpty()) {
			const keyId = keyhelper.generateSenderKeyId()
			const senderKey = keyhelper.generateSenderKey()
			const signingKey = keyhelper.generateSenderSigningKey()
			trace('group-session-builder', 'GroupSessionBuilder.create:creatingNewState', { keyId })

			senderKeyRecord.setSenderKeyState(keyId, 0, senderKey, signingKey)
			await this.senderKeyStore.storeSenderKey(senderKeyName, senderKeyRecord)
		}

		const state = senderKeyRecord.getSenderKeyState()
		if (!state) {
			throw new Error('No session state available')
		}

		const result = new SenderKeyDistributionMessage(
			state.getKeyId(),
			state.getSenderChainKey().getIteration(),
			state.getSenderChainKey().getSeed(),
			state.getSigningKeyPublic()
		)
		trace('group-session-builder', 'GroupSessionBuilder.create:return', {
			senderKeyName: senderKeyName.toString(),
			keyId: result.getId(),
			iteration: result.getIteration()
		})
		return result
	}
}
