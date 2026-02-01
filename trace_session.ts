/**
 * Trace Session Script
 * 
 * Runs Baileys with full trace instrumentation enabled.
 * All traces are written to /tmp/baileys_trace.log
 * 
 * Usage:
 *   npx tsx trace_session.ts                    # QR code mode
 *   npx tsx trace_session.ts --use-pairing-code # Pairing code mode
 */

import { Boom } from '@hapi/boom'
import NodeCache from '@cacheable/node-cache'
import readline from 'readline'
import makeWASocket, {
	CacheStore,
	DEFAULT_CONNECTION_CONFIG,
	DisconnectReason,
	fetchLatestBaileysVersion,
	makeCacheableSignalKeyStore,
	proto,
	useMultiFileAuthState,
	type WAMessageContent,
	type WAMessageKey
} from './src'
import P from 'pino'
import { trace } from './src/Utils/trace-logger'
import { appendFileSync } from 'fs'

// Configure pino logger at trace level for maximum detail
const logger = P({
	level: 'trace',
	transport: {
		targets: [
			{
				target: 'pino-pretty',
				options: { colorize: true },
				level: 'debug',
			},
			{
				target: 'pino/file',
				options: { destination: '/tmp/baileys_pino.log' },
				level: 'trace',
			},
		],
	},
})

const usePairingCode = process.argv.includes('--use-pairing-code')
const phoneNumber = process.argv.find((_, i, arr) => arr[i - 1] === '--phone')

const msgRetryCounterCache = new NodeCache() as CacheStore

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const question = (text: string) => new Promise<string>((resolve) => rl.question(text, resolve))

trace('trace-session', 'start', { usePairingCode, phoneNumber: phoneNumber || 'none' })

const startSock = async () => {
	trace('trace-session', 'startSock:enter', {})

	const { state, saveCreds } = await useMultiFileAuthState('trace_auth_info')
	trace('trace-session', 'authStateLoaded', {
		registered: state.creds.registered,
		hasMe: !!state.creds.me,
	})

	const { version, isLatest } = await fetchLatestBaileysVersion()
	trace('trace-session', 'waVersion', { version: version.join('.'), isLatest })

	const sock = makeWASocket({
		version,
		logger,
		waWebSocketUrl: process.env.SOCKET_URL ?? DEFAULT_CONNECTION_CONFIG.waWebSocketUrl,
		auth: {
			creds: state.creds,
			keys: makeCacheableSignalKeyStore(state.keys, logger),
		},
		msgRetryCounterCache,
		generateHighQualityLinkPreview: false,
		getMessage,
	})

	trace('trace-session', 'socketCreated', {})

	sock.ev.process(async (events) => {
		// Connection updates
		if (events['connection.update']) {
			const update = events['connection.update']
			const { connection, lastDisconnect, qr } = update
			trace('trace-session', 'connection.update', {
				connection,
				qr: qr ? 'present' : 'none',
				lastDisconnectStatus: (lastDisconnect?.error as Boom)?.output?.statusCode
			})

			if (connection === 'close') {
				const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode
				trace('trace-session', 'connection.close', { statusCode, reason: DisconnectReason[statusCode] })

				if (statusCode !== DisconnectReason.loggedOut) {
					trace('trace-session', 'reconnecting', {})
					startSock()
				} else {
					console.log('Logged out. Session ended.')
					trace('trace-session', 'loggedOut', {})

					// Write summary
					const summary = '\n\n=== SESSION ENDED (logged out) ===\n'
					appendFileSync('/tmp/baileys_trace.log', summary)
					process.exit(0)
				}
			}

			if (connection === 'open') {
				trace('trace-session', 'connection.open', { me: sock.user })
				console.log('\n=== CONNECTED SUCCESSFULLY ===')
				console.log(`Logged in as: ${sock.user?.id}`)
				console.log('Trace log: /tmp/baileys_trace.log')
				console.log('Pino log: /tmp/baileys_pino.log')
				console.log('\nPress Ctrl+C to stop and save logs.\n')
			}

			if (qr) {
				trace('trace-session', 'qrReceived', {})
				if (usePairingCode && !sock.authState.creds.registered) {
					const phone = phoneNumber || await question('Enter phone number (with country code, e.g. 5511999999999):\n')
					trace('trace-session', 'requestPairingCode', { phone })
					try {
						const code = await sock.requestPairingCode(phone)
						console.log(`\n>>> PAIRING CODE: ${code} <<<\n`)
						trace('trace-session', 'pairingCodeReceived', { code })
					} catch (err) {
						trace('trace-session', 'pairingCodeError', { error: (err as Error).message })
						console.error('Failed to get pairing code:', (err as Error).message)
					}
				}
			}
		}

		// Credentials updated
		if (events['creds.update']) {
			trace('trace-session', 'creds.update', {})
			await saveCreds()
		}

		// History sync
		if (events['messaging-history.set']) {
			const { chats, contacts, messages, isLatest, progress, syncType } = events['messaging-history.set']
			trace('trace-session', 'messaging-history.set', {
				chats: chats.length,
				contacts: contacts.length,
				messages: messages.length,
				isLatest,
				progress,
				syncType: syncType?.toString()
			})
		}

		// Messages received
		if (events['messages.upsert']) {
			const { messages, type, requestId } = events['messages.upsert']
			trace('trace-session', 'messages.upsert', {
				count: messages.length,
				type,
				requestId,
				firstMsgId: messages[0]?.key?.id,
				firstMsgFrom: messages[0]?.key?.remoteJid,
			})
		}

		// Messages updated
		if (events['messages.update']) {
			trace('trace-session', 'messages.update', {
				count: events['messages.update'].length
			})
		}

		// Contacts
		if (events['contacts.upsert']) {
			trace('trace-session', 'contacts.upsert', {
				count: events['contacts.upsert'].length
			})
		}

		// Groups
		if (events['groups.upsert']) {
			trace('trace-session', 'groups.upsert', {
				count: events['groups.upsert'].length
			})
		}

		// Presence
		if (events['presence.update']) {
			trace('trace-session', 'presence.update', events['presence.update'])
		}
	})

	return sock

	async function getMessage(key: WAMessageKey): Promise<WAMessageContent | undefined> {
		trace('trace-session', 'getMessage', { id: key.id, remoteJid: key.remoteJid })
		return proto.Message.create({ conversation: 'test' })
	}
}

// Graceful shutdown
process.on('SIGINT', () => {
	trace('trace-session', 'SIGINT', {})
	const summary = '\n\n=== SESSION ENDED (SIGINT) ===\n'
	appendFileSync('/tmp/baileys_trace.log', summary)
	console.log('\nSession ended. Logs saved to:')
	console.log('  Trace: /tmp/baileys_trace.log')
	console.log('  Pino:  /tmp/baileys_pino.log')
	process.exit(0)
})

startSock().catch(err => {
	trace('trace-session', 'fatalError', { error: err.message })
	console.error('Fatal error:', err)
	process.exit(1)
})
