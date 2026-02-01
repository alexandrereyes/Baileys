import { Boom } from '@hapi/boom'
import type { BinaryNode } from '../WABinary'
import { getBinaryNodeChild, S_WHATSAPP_NET } from '../WABinary'
import { trace } from '../Utils/trace-logger'

const wMexQuery = (
	variables: Record<string, unknown>,
	queryId: string,
	query: (node: BinaryNode) => Promise<BinaryNode>,
	generateMessageTag: () => string
) => {
	const tag = generateMessageTag()
	trace('mex', 'wMexQuery:enter', { queryId, tag, variableKeys: Object.keys(variables) })
	return query({
		tag: 'iq',
		attrs: {
			id: tag,
			type: 'get',
			to: S_WHATSAPP_NET,
			xmlns: 'w:mex'
		},
		content: [
			{
				tag: 'query',
				attrs: { query_id: queryId },
				content: Buffer.from(JSON.stringify({ variables }), 'utf-8')
			}
		]
	})
}

export const executeWMexQuery = async <T>(
	variables: Record<string, unknown>,
	queryId: string,
	dataPath: string,
	query: (node: BinaryNode) => Promise<BinaryNode>,
	generateMessageTag: () => string
): Promise<T> => {
	trace('mex', 'executeWMexQuery:enter', { queryId, dataPath })
	try {
		const result = await wMexQuery(variables, queryId, query, generateMessageTag)
		const child = getBinaryNodeChild(result, 'result')
		if (child?.content) {
			const data = JSON.parse(child.content.toString())

			if (data.errors && data.errors.length > 0) {
				const errorMessages = data.errors.map((err: Error) => err.message || 'Unknown error').join(', ')
				const firstError = data.errors[0]
				const errorCode = firstError.extensions?.error_code || 400
				trace('mex', 'executeWMexQuery:error', { errorCount: data.errors.length, errorCode })
				throw new Boom(`GraphQL server error: ${errorMessages}`, { statusCode: errorCode, data: firstError })
			}

			const response = dataPath ? data?.data?.[dataPath] : data?.data
			if (typeof response !== 'undefined') {
				trace('mex', 'executeWMexQuery:return', { hasData: true, dataPath })
				return response as T
			}
		}

		const action = (dataPath || '').startsWith('xwa2_')
			? dataPath.substring(5).replace(/_/g, ' ')
			: dataPath?.replace(/_/g, ' ')
		trace('mex', 'executeWMexQuery:error', { action })
		throw new Boom(`Failed to ${action}, unexpected response structure.`, { statusCode: 400, data: result })
	} catch (error) {
		if (error instanceof Boom) throw error
		trace('mex', 'executeWMexQuery:error', { error: (error as Error).message })
		throw error
	}
}