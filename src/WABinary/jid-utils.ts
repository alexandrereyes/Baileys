export const S_WHATSAPP_NET = '@s.whatsapp.net'
export const OFFICIAL_BIZ_JID = '16505361212@c.us'
export const SERVER_JID = 'server@c.us'
export const PSA_WID = '0@c.us'
export const STORIES_JID = 'status@broadcast'
export const META_AI_JID = '13135550002@c.us'

export type JidServer =
	| 'c.us'
	| 'g.us'
	| 'broadcast'
	| 's.whatsapp.net'
	| 'call'
	| 'lid'
	| 'newsletter'
	| 'bot'
	| 'hosted'
	| 'hosted.lid'

export enum WAJIDDomains {
	WHATSAPP = 0,
	LID = 1,
	HOSTED = 128,
	HOSTED_LID = 129
}

export type JidWithDevice = {
	user: string
	device?: number
}

export type FullJid = JidWithDevice & {
	server: JidServer
	domainType?: number
}

import { trace } from '../Utils/trace-logger'

export const getServerFromDomainType = (initialServer: string, domainType?: WAJIDDomains): JidServer => {
	trace('jid-utils', 'getServerFromDomainType:enter', { initialServer, domainType })
	let result: JidServer
	switch (domainType) {
		case WAJIDDomains.LID:
			result = 'lid'
			break
		case WAJIDDomains.HOSTED:
			result = 'hosted'
			break
		case WAJIDDomains.HOSTED_LID:
			result = 'hosted.lid'
			break
		case WAJIDDomains.WHATSAPP:
		default:
			result = initialServer as JidServer
			break
	}
	trace('jid-utils', 'getServerFromDomainType:return', { server: result })
	return result
}

export const jidEncode = (user: string | number | null, server: JidServer, device?: number, agent?: number) => {
	trace('jid-utils', 'jidEncode:enter', { user, server, device, agent })
	const result = `${user || ''}${!!agent ? `_${agent}` : ''}${!!device ? `:${device}` : ''}@${server}`
	trace('jid-utils', 'jidEncode:return', { jid: result })
	return result
}

export const jidDecode = (jid: string | undefined): FullJid | undefined => {
	trace('jid-utils', 'jidDecode:enter', { jid })
	// todo: investigate how to implement hosted ids in this case
	const sepIdx = typeof jid === 'string' ? jid.indexOf('@') : -1
	if (sepIdx < 0) {
		trace('jid-utils', 'jidDecode:return', { result: 'undefined', reason: 'invalid jid format' })
		return undefined
	}

	const server = jid!.slice(sepIdx + 1)
	const userCombined = jid!.slice(0, sepIdx)

	const [userAgent, device] = userCombined.split(':')
	const [user, agent] = userAgent!.split('_')

	let domainType = WAJIDDomains.WHATSAPP
	if (server === 'lid') {
		domainType = WAJIDDomains.LID
	} else if (server === 'hosted') {
		domainType = WAJIDDomains.HOSTED
	} else if (server === 'hosted.lid') {
		domainType = WAJIDDomains.HOSTED_LID
	} else if (agent) {
		domainType = parseInt(agent)
	}

	const result = {
		server: server as JidServer,
		user: user!,
		domainType,
		device: device ? +device : undefined
	}
	trace('jid-utils', 'jidDecode:return', { result })
	return result
}

/** is the jid a user */
export const areJidsSameUser = (jid1: string | undefined, jid2: string | undefined) => {
	trace('jid-utils', 'areJidsSameUser:enter', { jid1, jid2 })
	const result = jidDecode(jid1)?.user === jidDecode(jid2)?.user
	trace('jid-utils', 'areJidsSameUser:return', { result })
	return result
}
/** is the jid Meta AI */
export const isJidMetaAI = (jid: string | undefined) => {
	trace('jid-utils', 'isJidMetaAI:enter', { jid })
	const result = !!jid?.endsWith('@bot')
	trace('jid-utils', 'isJidMetaAI:return', { result })
	return result
}
/** is the jid a PN user */
export const isPnUser = (jid: string | undefined) => {
	trace('jid-utils', 'isPnUser:enter', { jid })
	const result = !!jid?.endsWith('@s.whatsapp.net')
	trace('jid-utils', 'isPnUser:return', { result })
	return result
}
/** is the jid a LID */
export const isLidUser = (jid: string | undefined) => {
	trace('jid-utils', 'isLidUser:enter', { jid })
	const result = !!jid?.endsWith('@lid')
	trace('jid-utils', 'isLidUser:return', { result })
	return result
}
/** is the jid a broadcast */
export const isJidBroadcast = (jid: string | undefined) => {
	trace('jid-utils', 'isJidBroadcast:enter', { jid })
	const result = !!jid?.endsWith('@broadcast')
	trace('jid-utils', 'isJidBroadcast:return', { result })
	return result
}
/** is the jid a group */
export const isJidGroup = (jid: string | undefined) => {
	trace('jid-utils', 'isJidGroup:enter', { jid })
	const result = !!jid?.endsWith('@g.us')
	trace('jid-utils', 'isJidGroup:return', { result })
	return result
}
/** is the jid the status broadcast */
export const isJidStatusBroadcast = (jid: string) => {
	trace('jid-utils', 'isJidStatusBroadcast:enter', { jid })
	const result = jid === 'status@broadcast'
	trace('jid-utils', 'isJidStatusBroadcast:return', { result })
	return result
}
/** is the jid a newsletter */
export const isJidNewsletter = (jid: string | undefined) => {
	trace('jid-utils', 'isJidNewsletter:enter', { jid })
	const result = !!jid?.endsWith('@newsletter')
	trace('jid-utils', 'isJidNewsletter:return', { result })
	return result
}
/** is the jid a hosted PN */
export const isHostedPnUser = (jid: string | undefined) => {
	trace('jid-utils', 'isHostedPnUser:enter', { jid })
	const result = !!jid?.endsWith('@hosted')
	trace('jid-utils', 'isHostedPnUser:return', { result })
	return result
}
/** is the jid a hosted LID */
export const isHostedLidUser = (jid: string | undefined) => {
	trace('jid-utils', 'isHostedLidUser:enter', { jid })
	const result = !!jid?.endsWith('@hosted.lid')
	trace('jid-utils', 'isHostedLidUser:return', { result })
	return result
}

const botRegexp = /^1313555\d{4}$|^131655500\d{2}$/

export const isJidBot = (jid: string | undefined) => {
	trace('jid-utils', 'isJidBot:enter', { jid })
	const result = jid ? botRegexp.test(jid.split('@')[0]!) && jid.endsWith('@c.us') : false
	trace('jid-utils', 'isJidBot:return', { result })
	return result
}

export const jidNormalizedUser = (jid: string | undefined) => {
	trace('jid-utils', 'jidNormalizedUser:enter', { jid })
	const result = jidDecode(jid)
	if (!result) {
		trace('jid-utils', 'jidNormalizedUser:return', { result: '' })
		return ''
	}

	const { user, server } = result
	const normalized = jidEncode(user, server === 'c.us' ? 's.whatsapp.net' : (server as JidServer))
	trace('jid-utils', 'jidNormalizedUser:return', { result: normalized })
	return normalized
}

export const transferDevice = (fromJid: string, toJid: string) => {
	trace('jid-utils', 'transferDevice:enter', { fromJid, toJid })
	const fromDecoded = jidDecode(fromJid)
	const deviceId = fromDecoded?.device || 0
	const { server, user } = jidDecode(toJid)!
	const result = jidEncode(user, server, deviceId)
	trace('jid-utils', 'transferDevice:return', { result })
	return result
}
