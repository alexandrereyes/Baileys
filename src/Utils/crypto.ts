import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'crypto'
import * as curve from 'libsignal/src/curve'
import { KEY_BUNDLE_TYPE } from '../Defaults'
import type { KeyPair } from '../Types'
import { trace } from './trace-logger'

// insure browser & node compatibility
const { subtle } = globalThis.crypto

/** prefix version byte to the pub keys, required for some curve crypto functions */
export const generateSignalPubKey = (pubKey: Uint8Array | Buffer) => {
	trace('crypto', 'generateSignalPubKey:enter', { pubKeyLen: pubKey.length })
	const result = pubKey.length === 33 ? pubKey : Buffer.concat([KEY_BUNDLE_TYPE, pubKey])
	trace('crypto', 'generateSignalPubKey:return', { resultLen: result.length })
	return result
}

export const Curve = {
	generateKeyPair: (): KeyPair => {
		trace('crypto', 'Curve.generateKeyPair:enter', {})
		const { pubKey, privKey } = curve.generateKeyPair()
		trace('crypto', 'Curve.generateKeyPair:return', { pubKeyLen: pubKey.length, privKeyLen: privKey.length })
		return {
			private: Buffer.from(privKey),
			// remove version byte
			public: Buffer.from(pubKey.slice(1))
		}
	},
	sharedKey: (privateKey: Uint8Array, publicKey: Uint8Array) => {
		trace('crypto', 'Curve.sharedKey:enter', { privateKeyLen: privateKey.length, publicKeyLen: publicKey.length })
		const shared = curve.calculateAgreement(generateSignalPubKey(publicKey), privateKey)
		const result = Buffer.from(shared)
		trace('crypto', 'Curve.sharedKey:return', { resultLen: result.length })
		return result
	},
	sign: (privateKey: Uint8Array, buf: Uint8Array) => {
		trace('crypto', 'Curve.sign:enter', { privateKeyLen: privateKey.length, bufLen: buf.length })
		const result = curve.calculateSignature(privateKey, buf)
		trace('crypto', 'Curve.sign:return', { signatureLen: result.length })
		return result
	},
	verify: (pubKey: Uint8Array, message: Uint8Array, signature: Uint8Array) => {
		trace('crypto', 'Curve.verify:enter', { pubKeyLen: pubKey.length, messageLen: message.length, signatureLen: signature.length })
		try {
			curve.verifySignature(generateSignalPubKey(pubKey), message, signature)
			trace('crypto', 'Curve.verify:return', { valid: true })
			return true
		} catch (error) {
			trace('crypto', 'Curve.verify:error', { error: (error as Error).message })
			return false
		}
	}
}

export const signedKeyPair = (identityKeyPair: KeyPair, keyId: number) => {
	trace('crypto', 'signedKeyPair:enter', { keyId })
	const preKey = Curve.generateKeyPair()
	const pubKey = generateSignalPubKey(preKey.public)

	const signature = Curve.sign(identityKeyPair.private, pubKey)

	trace('crypto', 'signedKeyPair:return', { signatureLen: signature.length })
	return { keyPair: preKey, signature, keyId }
}

const GCM_TAG_LENGTH = 128 >> 3

/**
 * encrypt AES 256 GCM;
 * where the tag tag is suffixed to the ciphertext
 * */
export function aesEncryptGCM(plaintext: Uint8Array, key: Uint8Array, iv: Uint8Array, additionalData: Uint8Array) {
	trace('crypto', 'aesEncryptGCM:enter', { plaintextLen: plaintext.length, keyLen: key.length, ivLen: iv.length, additionalDataLen: additionalData.length })
	const cipher = createCipheriv('aes-256-gcm', key, iv)
	cipher.setAAD(additionalData)
	const result = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
	trace('crypto', 'aesEncryptGCM:return', { resultLen: result.length })
	return result
}

/**
 * decrypt AES 256 GCM;
 * where the auth tag is suffixed to the ciphertext
 * */
export function aesDecryptGCM(ciphertext: Uint8Array, key: Uint8Array, iv: Uint8Array, additionalData: Uint8Array) {
	try {
		trace('crypto', 'aesDecryptGCM:enter', { ciphertextLen: ciphertext.length, keyLen: key.length, ivLen: iv.length, additionalDataLen: additionalData.length })
		const decipher = createDecipheriv('aes-256-gcm', key, iv)
		// decrypt additional adata
		const enc = ciphertext.slice(0, ciphertext.length - GCM_TAG_LENGTH)
		const tag = ciphertext.slice(ciphertext.length - GCM_TAG_LENGTH)
		// set additional data
		decipher.setAAD(additionalData)
		decipher.setAuthTag(tag)

		const result = Buffer.concat([decipher.update(enc), decipher.final()])
		trace('crypto', 'aesDecryptGCM:return', { resultLen: result.length })
		return result
	} catch (error) {
		trace('crypto', 'aesDecryptGCM:error', { error: (error as Error).message })
		throw error
	}
}

export function aesEncryptCTR(plaintext: Uint8Array, key: Uint8Array, iv: Uint8Array) {
	trace('crypto', 'aesEncryptCTR:enter', { plaintextLen: plaintext.length, keyLen: key.length, ivLen: iv.length })
	const cipher = createCipheriv('aes-256-ctr', key, iv)
	const result = Buffer.concat([cipher.update(plaintext), cipher.final()])
	trace('crypto', 'aesEncryptCTR:return', { resultLen: result.length })
	return result
}

export function aesDecryptCTR(ciphertext: Uint8Array, key: Uint8Array, iv: Uint8Array) {
	trace('crypto', 'aesDecryptCTR:enter', { ciphertextLen: ciphertext.length, keyLen: key.length, ivLen: iv.length })
	const decipher = createDecipheriv('aes-256-ctr', key, iv)
	const result = Buffer.concat([decipher.update(ciphertext), decipher.final()])
	trace('crypto', 'aesDecryptCTR:return', { resultLen: result.length })
	return result
}

/** decrypt AES 256 CBC; where the IV is prefixed to the buffer */
export function aesDecrypt(buffer: Buffer, key: Buffer) {
	trace('crypto', 'aesDecrypt:enter', { bufferLen: buffer.length, keyLen: key.length })
	const result = aesDecryptWithIV(buffer.slice(16, buffer.length), key, buffer.slice(0, 16))
	trace('crypto', 'aesDecrypt:return', { resultLen: result.length })
	return result
}

/** decrypt AES 256 CBC */
export function aesDecryptWithIV(buffer: Buffer, key: Buffer, IV: Buffer) {
	try {
		trace('crypto', 'aesDecryptWithIV:enter', { bufferLen: buffer.length, keyLen: key.length, ivLen: IV.length })
		const aes = createDecipheriv('aes-256-cbc', key, IV)
		const result = Buffer.concat([aes.update(buffer), aes.final()])
		trace('crypto', 'aesDecryptWithIV:return', { resultLen: result.length })
		return result
	} catch (error) {
		trace('crypto', 'aesDecryptWithIV:error', { error: (error as Error).message })
		throw error
	}
}

// encrypt AES 256 CBC; where a random IV is prefixed to the buffer
export function aesEncrypt(buffer: Buffer | Uint8Array, key: Buffer) {
	trace('crypto', 'aesEncrypt:enter', { bufferLen: buffer.length, keyLen: key.length })
	const IV = randomBytes(16)
	const aes = createCipheriv('aes-256-cbc', key, IV)
	const result = Buffer.concat([IV, aes.update(buffer), aes.final()]) // prefix IV to the buffer
	trace('crypto', 'aesEncrypt:return', { resultLen: result.length })
	return result
}

// encrypt AES 256 CBC with a given IV
export function aesEncrypWithIV(buffer: Buffer, key: Buffer, IV: Buffer) {
	trace('crypto', 'aesEncrypWithIV:enter', { bufferLen: buffer.length, keyLen: key.length, ivLen: IV.length })
	const aes = createCipheriv('aes-256-cbc', key, IV)
	const result = Buffer.concat([aes.update(buffer), aes.final()]) // prefix IV to the buffer
	trace('crypto', 'aesEncrypWithIV:return', { resultLen: result.length })
	return result
}

// sign HMAC using SHA 256
export function hmacSign(
	buffer: Buffer | Uint8Array,
	key: Buffer | Uint8Array,
	variant: 'sha256' | 'sha512' = 'sha256'
) {
	trace('crypto', 'hmacSign:enter', { bufferLen: buffer.length, keyLen: key.length, variant })
	const result = createHmac(variant, key).update(buffer).digest()
	trace('crypto', 'hmacSign:return', { resultLen: result.length })
	return result
}

export function sha256(buffer: Buffer) {
	trace('crypto', 'sha256:enter', { bufferLen: buffer.length })
	const result = createHash('sha256').update(buffer).digest()
	trace('crypto', 'sha256:return', { resultLen: result.length })
	return result
}

export function md5(buffer: Buffer) {
	trace('crypto', 'md5:enter', { bufferLen: buffer.length })
	const result = createHash('md5').update(buffer).digest()
	trace('crypto', 'md5:return', { resultLen: result.length })
	return result
}

// HKDF key expansion
export async function hkdf(
	buffer: Uint8Array | Buffer,
	expandedLength: number,
	info: { salt?: Buffer; info?: string }
): Promise<Buffer> {
	trace('crypto', 'hkdf:enter', { bufferLen: buffer.length, expandedLength, hasSalt: !!info.salt, hasInfo: !!info.info })
	// Normalize to a Uint8Array whose underlying buffer is a regular ArrayBuffer (not ArrayBufferLike)
	// Cloning via new Uint8Array(...) guarantees the generic parameter is ArrayBuffer which satisfies WebCrypto types.
	const inputKeyMaterial = new Uint8Array(buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer))

	// Set default values if not provided
	const salt = info.salt ? new Uint8Array(info.salt) : new Uint8Array(0)
	const infoBytes = info.info ? new TextEncoder().encode(info.info) : new Uint8Array(0)

	// Import the input key material (cast to BufferSource to appease TS DOM typings)
	const importedKey = await subtle.importKey('raw', inputKeyMaterial as BufferSource, { name: 'HKDF' }, false, [
		'deriveBits'
	])

	// Derive bits using HKDF
	const derivedBits = await subtle.deriveBits(
		{
			name: 'HKDF',
			hash: 'SHA-256',
			salt: salt,
			info: infoBytes
		},
		importedKey,
		expandedLength * 8 // Convert bytes to bits
	)

	const result = Buffer.from(derivedBits)
	trace('crypto', 'hkdf:return', { resultLen: result.length })
	return result
}

export async function derivePairingCodeKey(pairingCode: string, salt: Buffer): Promise<Buffer> {
	trace('crypto', 'derivePairingCodeKey:enter', { pairingCodeLen: pairingCode.length, saltLen: salt.length })
	// Convert inputs to formats Web Crypto API can work with
	const encoder = new TextEncoder()
	const pairingCodeBuffer = encoder.encode(pairingCode)
	const saltBuffer = new Uint8Array(salt instanceof Uint8Array ? salt : new Uint8Array(salt))

	// Import the pairing code as key material
	const keyMaterial = await subtle.importKey('raw', pairingCodeBuffer as BufferSource, { name: 'PBKDF2' }, false, [
		'deriveBits'
	])

	// Derive bits using PBKDF2 with the same parameters
	// 2 << 16 = 131,072 iterations
	const derivedBits = await subtle.deriveBits(
		{
			name: 'PBKDF2',
			salt: saltBuffer as BufferSource,
			iterations: 2 << 16,
			hash: 'SHA-256'
		},
		keyMaterial,
		32 * 8 // 32 bytes * 8 = 256 bits
	)

	const result = Buffer.from(derivedBits)
	trace('crypto', 'derivePairingCodeKey:return', { resultLen: result.length })
	return result
}
