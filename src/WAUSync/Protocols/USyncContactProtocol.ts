import type { USyncQueryProtocol } from '../../Types/USync'
import { assertNodeErrorFree, type BinaryNode } from '../../WABinary'
import { trace } from '../../Utils/trace-logger'
import { USyncUser } from '../USyncUser'

export class USyncContactProtocol implements USyncQueryProtocol {
	name = 'contact'

	getQueryElement(): BinaryNode {
		trace('USyncContactProtocol', 'getQueryElement', {})
		return {
			tag: 'contact',
			attrs: {}
		}
	}

	getUserElement(user: USyncUser): BinaryNode {
		trace('USyncContactProtocol', 'getUserElement', { phone: user.phone })
		//TODO: Implement type / username fields (not yet supported)
		return {
			tag: 'contact',
			attrs: {},
			content: user.phone
		}
	}

	parser(node: BinaryNode): boolean {
		trace('USyncContactProtocol', 'parser:enter', { tag: node.tag })
		if (node.tag === 'contact') {
			assertNodeErrorFree(node)
			const result = node?.attrs?.type === 'in'
			trace('USyncContactProtocol', 'parser:return', { isContact: result })
			return result
		}

		trace('USyncContactProtocol', 'parser:return', { isContact: false })
		return false
	}
}
