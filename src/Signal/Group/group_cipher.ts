import { decrypt, encrypt } from 'libsignal/src/crypto'
import { SenderKeyMessage } from './sender-key-message'
import { SenderKeyName } from './sender-key-name'
import { SenderKeyRecord } from './sender-key-record'
import { SenderKeyState } from './sender-key-state'
import { trace } from '../../Utils/trace-logger'

export interface SenderKeyStore {
	loadSenderKey(senderKeyName: SenderKeyName): Promise<SenderKeyRecord>

	storeSenderKey(senderKeyName: SenderKeyName, record: SenderKeyRecord): Promise<void>
}

export class GroupCipher {
	private readonly senderKeyStore: SenderKeyStore
	private readonly senderKeyName: SenderKeyName

	constructor(senderKeyStore: SenderKeyStore, senderKeyName: SenderKeyName) {
		trace('group-cipher', 'GroupCipher.constructor', { senderKeyName: senderKeyName.toString() })
		this.senderKeyStore = senderKeyStore
		this.senderKeyName = senderKeyName
	}

	public async encrypt(paddedPlaintext: Uint8Array): Promise<Uint8Array> {
		trace('group-cipher', 'GroupCipher.encrypt:enter', {
			senderKeyName: this.senderKeyName.toString(),
			plaintextLen: paddedPlaintext.length
		})
		const record = await this.senderKeyStore.loadSenderKey(this.senderKeyName)
		if (!record) {
			throw new Error('No SenderKeyRecord found for encryption')
		}

		const senderKeyState = record.getSenderKeyState()
		if (!senderKeyState) {
			throw new Error('No session to encrypt message')
		}
		trace('group-cipher', 'GroupCipher.encrypt:stateLoaded', { keyId: senderKeyState.getKeyId() })

		const iteration = senderKeyState.getSenderChainKey().getIteration()
		const senderKey = this.getSenderKey(senderKeyState, iteration === 0 ? 0 : iteration + 1)

		const ciphertext = await this.getCipherText(senderKey.getIv(), senderKey.getCipherKey(), paddedPlaintext)
		trace('group-cipher', 'GroupCipher.encrypt:encrypted', { iteration, ciphertextLen: ciphertext.length })

		const senderKeyMessage = new SenderKeyMessage(
			senderKeyState.getKeyId(),
			senderKey.getIteration(),
			ciphertext,
			senderKeyState.getSigningKeyPrivate()
		)

		await this.senderKeyStore.storeSenderKey(this.senderKeyName, record)
		const result = senderKeyMessage.serialize()
		trace('group-cipher', 'GroupCipher.encrypt:return', { resultLen: result.length })
		return result
	}

	public async decrypt(senderKeyMessageBytes: Uint8Array): Promise<Uint8Array> {
		trace('group-cipher', 'GroupCipher.decrypt:enter', {
			senderKeyName: this.senderKeyName.toString(),
			messageBytesLen: senderKeyMessageBytes.length
		})
		const record = await this.senderKeyStore.loadSenderKey(this.senderKeyName)
		if (!record) {
			throw new Error('No SenderKeyRecord found for decryption')
		}

		const senderKeyMessage = new SenderKeyMessage(null, null, null, null, senderKeyMessageBytes)
		const senderKeyState = record.getSenderKeyState(senderKeyMessage.getKeyId())
		if (!senderKeyState) {
			throw new Error('No session found to decrypt message')
		}
		trace('group-cipher', 'GroupCipher.decrypt:stateLoaded', { keyId: senderKeyMessage.getKeyId() })

		senderKeyMessage.verifySignature(senderKeyState.getSigningKeyPublic())
		const senderKey = this.getSenderKey(senderKeyState, senderKeyMessage.getIteration())
		trace('group-cipher', 'GroupCipher.decrypt:signatureVerified', { iteration: senderKeyMessage.getIteration() })

		const plaintext = await this.getPlainText(
			senderKey.getIv(),
			senderKey.getCipherKey(),
			senderKeyMessage.getCipherText()
		)

		await this.senderKeyStore.storeSenderKey(this.senderKeyName, record)
		trace('group-cipher', 'GroupCipher.decrypt:return', { plaintextLen: plaintext.length })
		return plaintext
	}

	private getSenderKey(senderKeyState: SenderKeyState, iteration: number) {
		let senderChainKey = senderKeyState.getSenderChainKey()
		if (senderChainKey.getIteration() > iteration) {
			if (senderKeyState.hasSenderMessageKey(iteration)) {
				const messageKey = senderKeyState.removeSenderMessageKey(iteration)
				if (!messageKey) {
					throw new Error('No sender message key found for iteration')
				}

				return messageKey
			}

			throw new Error(`Received message with old counter: ${senderChainKey.getIteration()}, ${iteration}`)
		}

		if (iteration - senderChainKey.getIteration() > 2000) {
			throw new Error('Over 2000 messages into the future!')
		}

		while (senderChainKey.getIteration() < iteration) {
			senderKeyState.addSenderMessageKey(senderChainKey.getSenderMessageKey())
			senderChainKey = senderChainKey.getNext()
		}

		senderKeyState.setSenderChainKey(senderChainKey.getNext())
		return senderChainKey.getSenderMessageKey()
	}

	private async getPlainText(iv: Uint8Array, key: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array> {
		try {
			trace('group-cipher', 'GroupCipher.getPlainText:enter', { ivLen: iv.length, keyLen: key.length, ciphertextLen: ciphertext.length })
			const result = await decrypt(key, ciphertext, iv)
			trace('group-cipher', 'GroupCipher.getPlainText:return', { plaintextLen: result.length })
			return result
		} catch (e) {
			trace('group-cipher', 'GroupCipher.getPlainText:error', { error: String(e) })
			throw new Error('InvalidMessageException')
		}
	}

	private async getCipherText(iv: Uint8Array, key: Uint8Array, plaintext: Uint8Array): Promise<Buffer> {
		try {
			trace('group-cipher', 'GroupCipher.getCipherText:enter', { ivLen: iv.length, keyLen: key.length, plaintextLen: plaintext.length })
			const result = await encrypt(key, plaintext, iv)
			trace('group-cipher', 'GroupCipher.getCipherText:return', { ciphertextLen: result.length })
			return result
		} catch (e) {
			trace('group-cipher', 'GroupCipher.getCipherText:error', { error: String(e) })
			throw new Error('InvalidMessageException')
		}
	}
}
