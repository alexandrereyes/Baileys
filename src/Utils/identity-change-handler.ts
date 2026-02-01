import NodeCache from '@cacheable/node-cache'
import { areJidsSameUser, type BinaryNode, getBinaryNodeChild, jidDecode } from '../WABinary'
import { isStringNullOrEmpty } from './generics'
import type { ILogger } from './logger'
import { trace } from './trace-logger'

export type IdentityChangeResult =
	| { action: 'no_identity_node' }
	| { action: 'invalid_notification' }
	| { action: 'skipped_companion_device'; device: number }
	| { action: 'skipped_self_primary' }
	| { action: 'debounced' }
	| { action: 'skipped_offline' }
	| { action: 'skipped_no_session' }
	| { action: 'session_refreshed' }
	| { action: 'session_refresh_failed'; error: unknown }

export type IdentityChangeContext = {
	meId: string | undefined
	meLid: string | undefined
	validateSession: (jid: string) => Promise<{ exists: boolean; reason?: string }>
	assertSessions: (jids: string[], force?: boolean) => Promise<boolean>
	debounceCache: NodeCache<boolean>
	logger: ILogger
}

export async function handleIdentityChange(
	node: BinaryNode,
	ctx: IdentityChangeContext
): Promise<IdentityChangeResult> {
	trace('identity-change-handler', 'handleIdentityChange:enter', { from: node.attrs.from })
	const from = node.attrs.from
	if (!from) {
		trace('identity-change-handler', 'handleIdentityChange:return', { result: 'invalid_notification' })
		return { action: 'invalid_notification' }
	}

	const identityNode = getBinaryNodeChild(node, 'identity')
	if (!identityNode) {
		trace('identity-change-handler', 'handleIdentityChange:return', { result: 'no_identity_node' })
		return { action: 'no_identity_node' }
	}

	ctx.logger.info({ jid: from }, 'identity changed')

	const decoded = jidDecode(from)
	if (decoded?.device && decoded.device !== 0) {
		trace('identity-change-handler', 'handleIdentityChange:return', { result: 'skipped_companion_device', device: decoded.device })
		ctx.logger.debug({ jid: from, device: decoded.device }, 'ignoring identity change from companion device')
		return { action: 'skipped_companion_device', device: decoded.device }
	}

	const isSelfPrimary = ctx.meId && (areJidsSameUser(from, ctx.meId) || (ctx.meLid && areJidsSameUser(from, ctx.meLid)))
	if (isSelfPrimary) {
		trace('identity-change-handler', 'handleIdentityChange:return', { result: 'skipped_self_primary' })
		ctx.logger.info({ jid: from }, 'self primary identity changed')
		return { action: 'skipped_self_primary' }
	}

	if (ctx.debounceCache.get(from)) {
		trace('identity-change-handler', 'handleIdentityChange:return', { result: 'debounced' })
		ctx.logger.debug({ jid: from }, 'skipping identity assert (debounced)')
		return { action: 'debounced' }
	}

	ctx.debounceCache.set(from, true)

	const isOfflineNotification = !isStringNullOrEmpty(node.attrs.offline)
	const hasExistingSession = await ctx.validateSession(from)

	if (!hasExistingSession.exists) {
		trace('identity-change-handler', 'handleIdentityChange:return', { result: 'skipped_no_session' })
		ctx.logger.debug({ jid: from }, 'no old session, skipping session refresh')
		return { action: 'skipped_no_session' }
	}

	ctx.logger.debug({ jid: from }, 'old session exists, will refresh session')

	if (isOfflineNotification) {
		trace('identity-change-handler', 'handleIdentityChange:return', { result: 'skipped_offline' })
		ctx.logger.debug({ jid: from }, 'skipping session refresh during offline processing')
		return { action: 'skipped_offline' }
	}

	try {
		await ctx.assertSessions([from], true)
		trace('identity-change-handler', 'handleIdentityChange:return', { result: 'session_refreshed' })
		return { action: 'session_refreshed' }
	} catch (error) {
		trace('identity-change-handler', 'handleIdentityChange:return', { result: 'session_refresh_failed', error })
		ctx.logger.warn({ error, jid: from }, 'failed to assert sessions after identity change')
		return { action: 'session_refresh_failed', error }
	}
}