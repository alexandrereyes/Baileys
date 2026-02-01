/**
 * Centralized trace logger for Baileys instrumentation.
 * Writes detailed function call traces to a file for analysis.
 * 
 * Usage:
 *   import { trace } from './trace-logger'
 *   trace('ModuleName', 'functionName', { arg1, arg2 })
 *   trace('ModuleName', 'functionName:result', { result })
 *   trace('ModuleName', 'functionName:error', { error })
 */

import { appendFileSync, writeFileSync } from 'fs'
import { inspect } from 'util'

const LOG_FILE = '/tmp/baileys_trace.log'
const MAX_DEPTH = 3
const MAX_STRING_LENGTH = 500
const startTime = Date.now()

// Clear log file on start
try {
	writeFileSync(LOG_FILE, `=== Baileys Trace Log Started at ${new Date().toISOString()} ===\n\n`)
} catch {
	// ignore
}

let callSequence = 0

function sanitizeValue(val: unknown, depth = 0): unknown {
	if (depth > MAX_DEPTH) return '[MAX_DEPTH]'
	if (val === null || val === undefined) return val
	if (val instanceof Buffer || val instanceof Uint8Array) {
		const len = val.length
		if (len <= 64) return `<Buffer:${len} ${Buffer.from(val).toString('hex')}>`
		return `<Buffer:${len} ${Buffer.from(val.slice(0, 32)).toString('hex')}...>`
	}
	if (typeof val === 'string') {
		return val.length > MAX_STRING_LENGTH ? val.slice(0, MAX_STRING_LENGTH) + '...' : val
	}
	if (typeof val === 'number' || typeof val === 'boolean') return val
	if (typeof val === 'function') return `[Function: ${val.name || 'anonymous'}]`
	if (Array.isArray(val)) {
		if (val.length > 10) return `[Array:${val.length} ${val.slice(0, 3).map(v => sanitizeValue(v, depth + 1)).join(', ')}...]`
		return val.map(v => sanitizeValue(v, depth + 1))
	}
	if (typeof val === 'object') {
		try {
			const obj: Record<string, unknown> = {}
			const keys = Object.keys(val as Record<string, unknown>)
			const limited = keys.slice(0, 15)
			for (const key of limited) {
				obj[key] = sanitizeValue((val as Record<string, unknown>)[key], depth + 1)
			}
			if (keys.length > 15) obj['...'] = `+${keys.length - 15} more keys`
			return obj
		} catch {
			return '[Object]'
		}
	}
	return String(val)
}

export function trace(module: string, fn: string, data?: Record<string, unknown>): void {
	try {
		const seq = ++callSequence
		const elapsed = Date.now() - startTime
		const ts = new Date().toISOString().slice(11, 23) // HH:mm:ss.SSS
		
		let sanitized = ''
		if (data) {
			const clean = sanitizeValue(data)
			sanitized = ' ' + inspect(clean, { depth: MAX_DEPTH, colors: false, compact: true, breakLength: 200 })
		}

		const line = `[${ts}] #${seq} +${elapsed}ms [${module}] ${fn}${sanitized}\n`
		appendFileSync(LOG_FILE, line)
	} catch {
		// never throw from trace
	}
}

export function traceCall<T>(module: string, fn: string, args: Record<string, unknown>, execute: () => T): T {
	trace(module, `${fn}:enter`, args)
	try {
		const result = execute()
		if (result instanceof Promise) {
			return (result as Promise<unknown>).then(
				(res) => {
					trace(module, `${fn}:return`, { result: res })
					return res
				},
				(err) => {
					trace(module, `${fn}:error`, { error: err?.message || err })
					throw err
				}
			) as T
		}
		trace(module, `${fn}:return`, { result })
		return result
	} catch (err) {
		trace(module, `${fn}:error`, { error: (err as Error)?.message || err })
		throw err
	}
}
