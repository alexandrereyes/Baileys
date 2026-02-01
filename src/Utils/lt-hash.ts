import { hkdf } from './crypto'
import { trace } from './trace-logger'

/**
 * LT Hash is a summation based hash algorithm that maintains the integrity of a piece of data
 * over a series of mutations. You can add/remove mutations and it'll return a hash equal to
 * if the same series of mutations was made sequentially.
 */
const o = 128

class LTHash {
	salt: string

	constructor(e: string) {
		this.salt = e
	}

	async add(e: ArrayBuffer, t: ArrayBuffer[]): Promise<ArrayBuffer> {
		trace('lt-hash', 'add:enter', { itemsCount: t.length })
		for (const item of t) {
			e = await this._addSingle(e, item)
		}

		const result = e
		trace('lt-hash', 'add:return', {})
		return result
	}

	async subtract(e: ArrayBuffer, t: ArrayBuffer[]): Promise<ArrayBuffer> {
		trace('lt-hash', 'subtract:enter', { itemsCount: t.length })
		for (const item of t) {
			e = await this._subtractSingle(e, item)
		}

		const result = e
		trace('lt-hash', 'subtract:return', {})
		return result
	}

	async subtractThenAdd(e: ArrayBuffer, addList: ArrayBuffer[], subtractList: ArrayBuffer[]): Promise<ArrayBuffer> {
		trace('lt-hash', 'subtractThenAdd:enter', { addCount: addList.length, subtractCount: subtractList.length })
		const subtracted = await this.subtract(e, subtractList)
		const result = this.add(subtracted, addList)
		trace('lt-hash', 'subtractThenAdd:return', {})
		return result
	}

	private async _addSingle(e: ArrayBuffer, t: ArrayBuffer): Promise<ArrayBuffer> {
		const derived = new Uint8Array(await hkdf(Buffer.from(t), o, { info: this.salt })).buffer
		return this.performPointwiseWithOverflow(e, derived, (a, b) => a + b)
	}

	private async _subtractSingle(e: ArrayBuffer, t: ArrayBuffer): Promise<ArrayBuffer> {
		const derived = new Uint8Array(await hkdf(Buffer.from(t), o, { info: this.salt })).buffer
		return this.performPointwiseWithOverflow(e, derived, (a, b) => a - b)
	}

	private performPointwiseWithOverflow(
		e: ArrayBuffer,
		t: ArrayBuffer,
		op: (a: number, b: number) => number
	): ArrayBuffer {
		const n = new DataView(e)
		const i = new DataView(t)
		const out = new ArrayBuffer(n.byteLength)
		const s = new DataView(out)

		for (let offset = 0; offset < n.byteLength; offset += 2) {
			s.setUint16(offset, op(n.getUint16(offset, true), i.getUint16(offset, true)), true)
		}

		return out
	}
}

export const LT_HASH_ANTI_TAMPERING = new LTHash('WhatsApp Patch Integrity')