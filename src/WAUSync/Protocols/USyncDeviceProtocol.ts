import type { USyncQueryProtocol } from '../../Types/USync'
import { assertNodeErrorFree, type BinaryNode, getBinaryNodeChild } from '../../WABinary'
import { trace } from '../../Utils/trace-logger'
//import { USyncUser } from '../USyncUser'

export type KeyIndexData = {
	timestamp: number
	signedKeyIndex?: Uint8Array
	expectedTimestamp?: number
}

export type DeviceListData = {
	id: number
	keyIndex?: number
	isHosted?: boolean
}

export type ParsedDeviceInfo = {
	deviceList?: DeviceListData[]
	keyIndex?: KeyIndexData
}

export class USyncDeviceProtocol implements USyncQueryProtocol {
	name = 'devices'

	getQueryElement(): BinaryNode {
		trace('USyncDeviceProtocol', 'getQueryElement', { version: '2' })
		return {
			tag: 'devices',
			attrs: {
				version: '2'
			}
		}
	}

	getUserElement(/* user: USyncUser */): BinaryNode | null {
		trace('USyncDeviceProtocol', 'getUserElement', {})
		//TODO: Implement device phashing, ts and expectedTs
		//TODO: if all are not present, return null <- current behavior
		//TODO: otherwise return a node w tag 'devices' w those as attrs
		return null
	}

	parser(node: BinaryNode): ParsedDeviceInfo {
		trace('USyncDeviceProtocol', 'parser:enter', { tag: node.tag })
		const deviceList: DeviceListData[] = []
		let keyIndex: KeyIndexData | undefined = undefined

		if (node.tag === 'devices') {
			assertNodeErrorFree(node)
			const deviceListNode = getBinaryNodeChild(node, 'device-list')
			const keyIndexNode = getBinaryNodeChild(node, 'key-index-list')

			if (Array.isArray(deviceListNode?.content)) {
				for (const { tag, attrs } of deviceListNode.content) {
					const id = +attrs.id!
					const keyIndex = +attrs['key-index']!
					if (tag === 'device') {
						deviceList.push({
							id,
							keyIndex,
							isHosted: !!(attrs['is_hosted'] && attrs['is_hosted'] === 'true')
						})
					}
				}
			}

			if (keyIndexNode?.tag === 'key-index-list') {
				keyIndex = {
					timestamp: +keyIndexNode.attrs['ts']!,
					signedKeyIndex: keyIndexNode?.content as Uint8Array,
					expectedTimestamp: keyIndexNode.attrs['expected_ts'] ? +keyIndexNode.attrs['expected_ts'] : undefined
				}
			}
		}

		const result = {
			deviceList,
			keyIndex
		}
		trace('USyncDeviceProtocol', 'parser:return', { deviceListCount: deviceList.length, hasKeyIndex: !!keyIndex })
		return result
	}
}
