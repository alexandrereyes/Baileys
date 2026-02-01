import { EventEmitter } from 'events'
import { URL } from 'url'
import type { SocketConfig } from '../../Types'
import { trace } from '../../Utils/trace-logger'

export abstract class AbstractSocketClient extends EventEmitter {
	constructor(
		public url: URL,
		public config: SocketConfig
	) {
		trace('types', 'AbstractSocketClient:constructor', { url: url.href })
		super()
		this.setMaxListeners(0)
		trace('types', 'AbstractSocketClient:constructor:return')
	}

	abstract get isOpen(): boolean
	abstract get isClosed(): boolean
	abstract get isClosing(): boolean
	abstract get isConnecting(): boolean

	abstract connect(): void
	abstract close(): void
	abstract send(str: Uint8Array | string, cb?: (err?: Error) => void): boolean
}