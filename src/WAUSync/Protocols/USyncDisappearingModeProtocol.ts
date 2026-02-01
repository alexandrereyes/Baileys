import type { USyncQueryProtocol } from '../../Types/USync'
import { assertNodeErrorFree, type BinaryNode } from '../../WABinary'
import { trace } from '../../Utils/trace-logger'

export type DisappearingModeData = {
	duration: number
	setAt?: Date
}

export class USyncDisappearingModeProtocol implements USyncQueryProtocol {
	name = 'disappearing_mode'

	getQueryElement(): BinaryNode {
		trace('USyncDisappearingModeProtocol', 'getQueryElement', {})
		return {
			tag: 'disappearing_mode',
			attrs: {}
		}
	}

	getUserElement(): null {
		trace('USyncDisappearingModeProtocol', 'getUserElement', {})
		return null
	}

	parser(node: BinaryNode): DisappearingModeData | undefined {
		trace('USyncDisappearingModeProtocol', 'parser:enter', { tag: node.tag })
		if (node.tag === 'disappearing_mode') {
			assertNodeErrorFree(node)
			const duration: number = +node?.attrs.duration!
			const setAt = new Date(+(node?.attrs.t || 0) * 1000)

			const result = {
				duration,
				setAt
			}
			trace('USyncDisappearingModeProtocol', 'parser:return', { duration, setAt })
			return result
		}
	}
}
