import { Mutex as AsyncMutex } from 'async-mutex'
import { trace } from './trace-logger'

export const makeMutex = () => {
	trace('make-mutex', 'makeMutex:enter', {})
	const mutex = new AsyncMutex()

	const result = {
		mutex<T>(code: () => Promise<T> | T): Promise<T> {
			return mutex.runExclusive(code)
		}
	}
	trace('make-mutex', 'makeMutex:return', {})
	return result
}

export type Mutex = ReturnType<typeof makeMutex>

export const makeKeyedMutex = () => {
	trace('make-mutex', 'makeKeyedMutex:enter', {})
	const map = new Map<string, { mutex: AsyncMutex; refCount: number }>()

	const result = {
		async mutex<T>(key: string, task: () => Promise<T> | T): Promise<T> {
			let entry = map.get(key)

			if (!entry) {
				entry = { mutex: new AsyncMutex(), refCount: 0 }
				map.set(key, entry)
			}

			entry.refCount++

			try {
				const returnValue = await entry.mutex.runExclusive(task)
				trace('make-mutex', 'makeKeyedMutex:mutex:return', { key, refCount: entry.refCount })
				return returnValue
			} finally {
				entry.refCount--
				// only delete it if this is still the current entry
				if (entry.refCount === 0 && map.get(key) === entry) {
					map.delete(key)
				}
			}
		}
	}
	trace('make-mutex', 'makeKeyedMutex:return', {})
	return result
}

export type KeyedMutex = ReturnType<typeof makeKeyedMutex>