import { BufferJSON } from '../../Utils/generics'
import { SenderKeyState } from './sender-key-state'
import { trace } from '../../Utils/trace-logger'

export interface SenderKeyStateStructure {
	senderKeyId: number
	senderChainKey: {
		iteration: number
		seed: Uint8Array
	}
	senderSigningKey: {
		public: Uint8Array
		private?: Uint8Array
	}
	senderMessageKeys: Array<{
		iteration: number
		seed: Uint8Array
	}>
}

export class SenderKeyRecord {
	private readonly MAX_STATES = 5
	private readonly senderKeyStates: SenderKeyState[] = []

	constructor(serialized?: SenderKeyStateStructure[]) {
		trace('sender-key-record', 'SenderKeyRecord.constructor', { hasSerialized: !!serialized, statesCount: serialized?.length || 0 })
		if (serialized) {
			for (const structure of serialized) {
				this.senderKeyStates.push(new SenderKeyState(null, null, null, null, null, null, structure))
			}
		}
	}

	public isEmpty(): boolean {
		return this.senderKeyStates.length === 0
	}

	public getSenderKeyState(keyId?: number): SenderKeyState | undefined {
		if (keyId === undefined && this.senderKeyStates.length) {
			return this.senderKeyStates[this.senderKeyStates.length - 1]
		}

		return this.senderKeyStates.find(state => state.getKeyId() === keyId)
	}

	public addSenderKeyState(id: number, iteration: number, chainKey: Uint8Array, signatureKey: Uint8Array): void {
		trace('sender-key-record', 'SenderKeyRecord.addSenderKeyState', { id, iteration, chainKeyLen: chainKey.length, signatureKeyLen: signatureKey.length })
		this.senderKeyStates.push(new SenderKeyState(id, iteration, chainKey, null, signatureKey))
		if (this.senderKeyStates.length > this.MAX_STATES) {
			trace('sender-key-record', 'SenderKeyRecord.addSenderKeyState:shifted', { statesCount: this.senderKeyStates.length })
			this.senderKeyStates.shift()
		}
	}

	public setSenderKeyState(
		id: number,
		iteration: number,
		chainKey: Uint8Array,
		keyPair: { public: Uint8Array; private: Uint8Array }
	): void {
		trace('sender-key-record', 'SenderKeyRecord.setSenderKeyState', { id, iteration, chainKeyLen: chainKey.length, publicKeyLen: keyPair.public.length })
		this.senderKeyStates.length = 0
		this.senderKeyStates.push(new SenderKeyState(id, iteration, chainKey, keyPair))
	}

	public serialize(): SenderKeyStateStructure[] {
		return this.senderKeyStates.map(state => state.getStructure())
	}
	static deserialize(data: Uint8Array): SenderKeyRecord {
		trace('sender-key-record', 'SenderKeyRecord.deserialize', { dataLen: data.length })
		const str = Buffer.from(data).toString('utf-8')
		const parsed = JSON.parse(str, BufferJSON.reviver)
		return new SenderKeyRecord(parsed)
	}
}
