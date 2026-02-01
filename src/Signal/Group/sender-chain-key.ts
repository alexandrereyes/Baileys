import { calculateMAC } from 'libsignal/src/crypto'
import { SenderMessageKey } from './sender-message-key'
import { trace } from '../../Utils/trace-logger'

export class SenderChainKey {
	private readonly MESSAGE_KEY_SEED: Uint8Array = Buffer.from([0x01])
	private readonly CHAIN_KEY_SEED: Uint8Array = Buffer.from([0x02])
	private readonly iteration: number
	private readonly chainKey: Buffer

	constructor(iteration: number, chainKey: Uint8Array | Buffer) {
		trace('sender-chain-key', 'SenderChainKey.constructor', { iteration, chainKeyLen: chainKey.length })
		this.iteration = iteration
		this.chainKey = Buffer.from(chainKey)
	}

	public getIteration(): number {
		return this.iteration
	}

	public getSenderMessageKey(): SenderMessageKey {
		trace('sender-chain-key', 'SenderChainKey.getSenderMessageKey', { iteration: this.iteration })
		return new SenderMessageKey(this.iteration, this.getDerivative(this.MESSAGE_KEY_SEED, this.chainKey))
	}

	public getNext(): SenderChainKey {
		const nextChainKey = this.getDerivative(this.CHAIN_KEY_SEED, this.chainKey)
		trace('sender-chain-key', 'SenderChainKey.getNext', { currentIteration: this.iteration, nextIteration: this.iteration + 1 })
		return new SenderChainKey(this.iteration + 1, nextChainKey)
	}

	public getSeed(): Uint8Array {
		return this.chainKey
	}

	private getDerivative(seed: Uint8Array, key: Buffer): Uint8Array {
		trace('sender-chain-key', 'SenderChainKey.getDerivative', { seedLen: seed.length, keyLen: key.length })
		return calculateMAC(key, seed)
	}
}
