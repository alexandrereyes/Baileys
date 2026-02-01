import WebSocket from 'ws'
import { DEFAULT_ORIGIN } from '../../Defaults'
import { AbstractSocketClient } from './types'
import { trace } from '../../Utils/trace-logger'

export class WebSocketClient extends AbstractSocketClient {
	protected socket: WebSocket | null = null

	get isOpen(): boolean {
		return this.socket?.readyState === WebSocket.OPEN
	}
	get isClosed(): boolean {
		return this.socket === null || this.socket?.readyState === WebSocket.CLOSED
	}
	get isClosing(): boolean {
		return this.socket === null || this.socket?.readyState === WebSocket.CLOSING
	}
	get isConnecting(): boolean {
		return this.socket === null || this.socket?.readyState === WebSocket.CONNECTING
	}

	connect() {
		trace('websocket', 'connect:enter', { url: this.url.href })
		if (this.socket) {
			trace('websocket', 'connect:return-already-connected')
			return
		}

		this.socket = new WebSocket(this.url, {
			origin: DEFAULT_ORIGIN,
			headers: this.config.options?.headers as {},
			handshakeTimeout: this.config.connectTimeoutMs,
			timeout: this.config.connectTimeoutMs,
			agent: this.config.agent
		})

		this.socket.setMaxListeners(0)

		const events = ['close', 'error', 'upgrade', 'message', 'open', 'ping', 'pong', 'unexpected-response']

		for (const event of events) {
			this.socket?.on(event, (...args: any[]) => {
				if (event === 'open') {
					trace('websocket', 'event:open', { url: this.url.href })
				}
				this.emit(event, ...args)
			})
		}
		trace('websocket', 'connect:return', { eventsCount: events.length })
	}

	async close() {
		trace('websocket', 'close:enter', { isOpen: this.isOpen })
		if (!this.socket) {
			trace('websocket', 'close:return-no-socket')
			return
		}

		const closePromise = new Promise<void>(resolve => {
			this.socket?.once('close', resolve)
		})

		this.socket.close()
		trace('websocket', 'close:socket-closed-waiting')

		await closePromise

		this.socket = null
		trace('websocket', 'close:return')
	}
	send(str: string | Uint8Array, cb?: (err?: Error) => void): boolean {
		const length = typeof str === 'string' ? str.length : str.length
		trace('websocket', 'send:enter', { type: typeof str, length })
		this.socket?.send(str, cb)

		const hasSocket = Boolean(this.socket)
		trace('websocket', 'send:return', { hasSocket })
		return hasSocket
	}
}