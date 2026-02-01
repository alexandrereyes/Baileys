import type { SignalKeyStoreWithTransaction } from '../Types'
import type { BinaryNode } from '../WABinary'
import { trace } from './trace-logger'

type TcTokenParams = {
	jid: string
	baseContent?: BinaryNode[]
	authState: {
		keys: SignalKeyStoreWithTransaction
	}
}

export async function buildTcTokenFromJid({
	authState,
	jid,
	baseContent = []
}: TcTokenParams): Promise<BinaryNode[] | undefined> {
	trace('tc-token-utils', 'buildTcTokenFromJid:enter', { jid })
	try {
		const tcTokenData = await authState.keys.get('tctoken', [jid])

		const tcTokenBuffer = tcTokenData?.[jid]?.token

		if (!tcTokenBuffer) {
			trace('tc-token-utils', 'buildTcTokenFromJid:return', { hasToken: false, hasBaseContent: baseContent.length > 0 })
			return baseContent.length > 0 ? baseContent : undefined
		}

		baseContent.push({
			tag: 'tctoken',
			attrs: {},
			content: tcTokenBuffer
		})

		trace('tc-token-utils', 'buildTcTokenFromJid:return', { hasToken: true })
		return baseContent
	} catch (error) {
		trace('tc-token-utils', 'buildTcTokenFromJid:return', { hasToken: false, hasBaseContent: baseContent.length > 0, error })
		return baseContent.length > 0 ? baseContent : undefined
	}
}