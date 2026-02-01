import type { USyncQueryProtocol } from '../../Types/USync'
import type { BinaryNode } from '../../WABinary'
import { trace } from '../../Utils/trace-logger'
import type { USyncUser } from '../USyncUser'

export class USyncLIDProtocol implements USyncQueryProtocol {
	name = 'lid'

	getQueryElement(): BinaryNode {
		trace('UsyncLIDProtocol', 'getQueryElement', {})
		return {
			tag: 'lid',
			attrs: {}
		}
	}

	getUserElement(user: USyncUser): BinaryNode | null {
		trace('UsyncLIDProtocol', 'getUserElement', { hasLid: !!user.lid })
		if (user.lid) {
			return {
				tag: 'lid',
				attrs: { jid: user.lid }
			}
		} else {
			return null
		}
	}

	parser(node: BinaryNode): string | null {
		trace('UsyncLIDProtocol', 'parser:enter', { tag: node.tag })
		if (node.tag === 'lid') {
			const result = node.attrs.val!
			trace('UsyncLIDProtocol', 'parser:return', { hasValue: !!result })
			return result
		}

		trace('UsyncLIDProtocol', 'parser:return', { hasValue: false })
		return null
	}
}
