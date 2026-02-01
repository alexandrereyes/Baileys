import * as nodeCrypto from 'crypto'
import { generateKeyPair } from 'libsignal/src/curve'
import { trace } from '../../Utils/trace-logger'

type KeyPairType = ReturnType<typeof generateKeyPair>

export function generateSenderKey(): Buffer {
	trace('keyhelper', 'generateSenderKey')
	return nodeCrypto.randomBytes(32)
}

export function generateSenderKeyId(): number {
	const id = nodeCrypto.randomInt(2147483647)
	trace('keyhelper', 'generateSenderKeyId', { id })
	return id
}

export interface SigningKeyPair {
	public: Buffer
	private: Buffer
}

export function generateSenderSigningKey(key?: KeyPairType): SigningKeyPair {
	trace('keyhelper', 'generateSenderSigningKey', { hasProvidedKey: !!key })
	if (!key) {
		key = generateKeyPair()
	}

	return {
		public: Buffer.from(key.pubKey),
		private: Buffer.from(key.privKey)
	}
}
