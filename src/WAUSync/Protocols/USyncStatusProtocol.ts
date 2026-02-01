import type { USyncQueryProtocol } from '../../Types/USync'
import { assertNodeErrorFree, type BinaryNode } from '../../WABinary'
import { trace } from '../../Utils/trace-logger'

export type StatusData = {
	status?: string | null
	setAt?: Date
}

export class USyncStatusProtocol implements USyncQueryProtocol {
	name = 'status'

	getQueryElement(): BinaryNode {
		trace('USyncStatusProtocol', 'getQueryElement', {})
		return {
			tag: 'status',
			attrs: {}
		}
	}

	getUserElement(): null {
		trace('USyncStatusProtocol', 'getUserElement', {})
		return null
	}

	parser(node: BinaryNode): StatusData | undefined {
		trace('USyncStatusProtocol', 'parser:enter', { tag: node.tag, hasContent: !!node.content })
		if (node.tag === 'status') {
			assertNodeErrorFree(node)
			let status: string | null = node?.content?.toString() ?? null
			const setAt = new Date(+(node?.attrs.t || 0) * 1000)
			if (!status) {
				if (node.attrs?.code && +node.attrs.code === 401) {
					status = ''
				} else {
					status = null
				}
} else if (typeof status === 'string' && status.length === 0) {
					status = null
				}

			const result = {
				status,
				setAt
			}
			trace('USyncStatusProtocol', 'parser:return', { hasStatus: !!status, setAt })
			return result
		}
	}
}
