import { trace } from '../Utils/trace-logger'
import { Boom } from '@hapi/boom'
import { proto } from '../../WAProto/index.js'
import { type BinaryNode } from './types'

// some extra useful utilities

const indexCache = new WeakMap<BinaryNode, Map<string, BinaryNode[]>>()

export const getBinaryNodeChildren = (node: BinaryNode | undefined, childTag: string) => {
	trace('wa-binary-utils', 'getBinaryNodeChildren:enter', { nodeTag: node?.tag, childTag })
	if (!node || !Array.isArray(node.content)) {
		trace('wa-binary-utils', 'getBinaryNodeChildren:return', { count: 0 })
		return []
	}

	let index = indexCache.get(node)

	// Build the index once per node
	if (!index) {
		index = new Map<string, BinaryNode[]>()

		for (const child of node.content) {
			let arr = index.get(child.tag)
			if (!arr) index.set(child.tag, (arr = []))
			arr.push(child)
		}

		indexCache.set(node, index)
	}

	// Return first matching child
	const result = index.get(childTag) || []
	trace('wa-binary-utils', 'getBinaryNodeChildren:return', { count: result.length })
	return result
}

export const getBinaryNodeChild = (node: BinaryNode | undefined, childTag: string) => {
	trace('wa-binary-utils', 'getBinaryNodeChild:enter', { nodeTag: node?.tag, childTag })
	const result = getBinaryNodeChildren(node, childTag)[0]
	trace('wa-binary-utils', 'getBinaryNodeChild:return', { found: !!result })
	return result
}

export const getAllBinaryNodeChildren = ({ content }: BinaryNode) => {
	trace('wa-binary-utils', 'getAllBinaryNodeChildren:enter')
	const result = Array.isArray(content) ? content : []
	trace('wa-binary-utils', 'getAllBinaryNodeChildren:return', { count: result.length })
	return result
}

export const getBinaryNodeChildBuffer = (node: BinaryNode | undefined, childTag: string) => {
	trace('wa-binary-utils', 'getBinaryNodeChildBuffer:enter', { nodeTag: node?.tag, childTag })
	const child = getBinaryNodeChild(node, childTag)?.content
	if (Buffer.isBuffer(child) || child instanceof Uint8Array) {
		trace('wa-binary-utils', 'getBinaryNodeChildBuffer:return', { bufferLen: child.length })
		return child
	}
	trace('wa-binary-utils', 'getBinaryNodeChildBuffer:return', { result: undefined })
}

export const getBinaryNodeChildString = (node: BinaryNode | undefined, childTag: string) => {
	trace('wa-binary-utils', 'getBinaryNodeChildString:enter', { nodeTag: node?.tag, childTag })
	const child = getBinaryNodeChild(node, childTag)?.content
	let result: string | undefined
	if (Buffer.isBuffer(child) || child instanceof Uint8Array) {
		result = Buffer.from(child).toString('utf-8')
	} else if (typeof child === 'string') {
		result = child
	}
	trace('wa-binary-utils', 'getBinaryNodeChildString:return', { result, length: result?.length })
	return result
}

export const getBinaryNodeChildUInt = (node: BinaryNode, childTag: string, length: number) => {
	trace('wa-binary-utils', 'getBinaryNodeChildUInt:enter', { nodeTag: node.tag, childTag, length })
	const buff = getBinaryNodeChildBuffer(node, childTag)
	if (buff) {
		const result = bufferToUInt(buff, length)
		trace('wa-binary-utils', 'getBinaryNodeChildUInt:return', { result })
		return result
	}
	trace('wa-binary-utils', 'getBinaryNodeChildUInt:return', { result: undefined })
}

export const assertNodeErrorFree = (node: BinaryNode) => {
	trace('wa-binary-utils', 'assertNodeErrorFree:enter', { nodeTag: node.tag })
	const errNode = getBinaryNodeChild(node, 'error')
	if (errNode) {
		trace('wa-binary-utils', 'assertNodeErrorFree:error', { code: errNode.attrs.code, text: errNode.attrs.text })
		throw new Boom(errNode.attrs.text || 'Unknown error', { data: +errNode.attrs.code! })
	}
	trace('wa-binary-utils', 'assertNodeErrorFree:return', { result: 'error-free' })
}

export const reduceBinaryNodeToDictionary = (node: BinaryNode, tag: string) => {
	trace('wa-binary-utils', 'reduceBinaryNodeToDictionary:enter', { nodeTag: node.tag, tag })
	const nodes = getBinaryNodeChildren(node, tag)
	const dict = nodes.reduce(
		(dict, { attrs }) => {
			if (typeof attrs.name === 'string') {
				dict[attrs.name] = attrs.value! || attrs.config_value!
			} else {
				dict[attrs.config_code!] = attrs.value! || attrs.config_value!
			}

			return dict
		},
		{} as { [_: string]: string }
	)
	trace('wa-binary-utils', 'reduceBinaryNodeToDictionary:return', { count: Object.keys(dict).length })
	return dict
}

export const getBinaryNodeMessages = ({ content }: BinaryNode) => {
	trace('wa-binary-utils', 'getBinaryNodeMessages:enter')
	const msgs: proto.WebMessageInfo[] = []
	if (Array.isArray(content)) {
		for (const item of content) {
			if (item.tag === 'message') {
				msgs.push(proto.WebMessageInfo.decode(item.content as Buffer).toJSON() as proto.WebMessageInfo)
			}
		}
	}

	trace('wa-binary-utils', 'getBinaryNodeMessages:return', { count: msgs.length })
	return msgs
}

function bufferToUInt(e: Uint8Array | Buffer, t: number) {
	let a = 0
	for (let i = 0; i < t; i++) {
		a = 256 * a + e[i]!
	}

	return a
}

const tabs = (n: number) => '\t'.repeat(n)

export function binaryNodeToString(node: BinaryNode | BinaryNode['content'], i = 0): string {
	if (!node) {
		return node!
	}

	if (typeof node === 'string') {
		return tabs(i) + node
	}

	if (node instanceof Uint8Array) {
		return tabs(i) + Buffer.from(node).toString('hex')
	}

	if (Array.isArray(node)) {
		return node.map(x => tabs(i + 1) + binaryNodeToString(x, i + 1)).join('\n')
	}

	const children = binaryNodeToString(node.content, i + 1)

	const tag = `<${node.tag} ${Object.entries(node.attrs || {})
		.filter(([, v]) => v !== undefined)
		.map(([k, v]) => `${k}='${v}'`)
		.join(' ')}`

	const content: string = children ? `>\n${children}\n${tabs(i)}</${node.tag}>` : '/>'

	return tag + content
}
