import type { EventInputType } from './constants'
import { trace } from '../Utils/trace-logger'

export class BinaryInfo {
	protocolVersion = 5
	sequence = 0
	events = [] as EventInputType[]
	buffer: Buffer[] = []

	constructor(options: Partial<BinaryInfo> = {}) {
		trace('BinaryInfo', 'constructor', { protocolVersion: options.protocolVersion, sequence: options.sequence, eventsCount: options.events?.length })
		Object.assign(this, options)
	}
}
