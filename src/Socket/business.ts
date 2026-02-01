import type { GetCatalogOptions, ProductCreate, ProductUpdate, SocketConfig, WAMediaUpload } from '../Types'
import type { UpdateBussinesProfileProps } from '../Types/Bussines'
import { getRawMediaUploadData } from '../Utils'
import {
	parseCatalogNode,
	parseCollectionsNode,
	parseOrderDetailsNode,
	parseProductNode,
	toProductNode,
	uploadingNecessaryImagesOfProduct
} from '../Utils/business'
import { type BinaryNode, jidNormalizedUser, S_WHATSAPP_NET } from '../WABinary'
import { getBinaryNodeChild } from '../WABinary/generic-utils'
import { makeMessagesRecvSocket } from './messages-recv'
import { trace } from '../Utils/trace-logger'

export const makeBusinessSocket = (config: SocketConfig) => {
	trace('business', 'makeBusinessSocket:enter')
	const sock = makeMessagesRecvSocket(config)
	const { authState, query, waUploadToServer } = sock

	const updateBussinesProfile = async (args: UpdateBussinesProfileProps) => {
		trace('business', 'updateBusinessProfile:enter', { hasAddress: !!args.address, hasEmail: !!args.email, hasDescription: !!args.description })
		try {
			const node: BinaryNode[] = []
			const simpleFields: (keyof UpdateBussinesProfileProps)[] = ['address', 'email', 'description']

			node.push(
				...simpleFields
					.filter(key => args[key] !== undefined && args[key] !== null)
					.map(key => ({
						tag: key,
						attrs: {},
						content: args[key] as string
					}))
			)

			if (args.websites !== undefined) {
				node.push(
					...args.websites.map(website => ({
						tag: 'website',
						attrs: {},
						content: website
					}))
				)
			}

			if (args.hours !== undefined) {
				node.push({
					tag: 'business_hours',
					attrs: { timezone: args.hours.timezone },
					content: args.hours.days.map(dayConfig => {
						const base = {
							tag: 'business_hours_config',
							attrs: {
								day_of_week: dayConfig.day,
								mode: dayConfig.mode
							}
						} as const

						if (dayConfig.mode === 'specific_hours') {
							return {
								...base,
								attrs: {
									...base.attrs,
									open_time: dayConfig.openTimeInMinutes,
									close_time: dayConfig.closeTimeInMinutes
								}
							}
						}

						return base
					})
				})
			}

			const result = await query({
				tag: 'iq',
				attrs: {
					to: S_WHATSAPP_NET,
					type: 'set',
					xmlns: 'w:biz'
				},
				content: [
					{
						tag: 'business_profile',
						attrs: {
							v: '3',
							mutation_type: 'delta'
						},
						content: node
					}
				]
			})

			trace('business', 'updateBusinessProfile:return')
			return result
		} catch (error) {
			trace('business', 'updateBusinessProfile:error', { error: (error as Error).message })
			throw error
		}
	}

	const updateCoverPhoto = async (photo: WAMediaUpload) => {
		trace('business', 'updateCoverPhoto:enter')
		try {
			const { fileSha256, filePath } = await getRawMediaUploadData(photo, 'biz-cover-photo')
			const fileSha256B64 = fileSha256.toString('base64')

			const { meta_hmac, fbid, ts } = await waUploadToServer(filePath, {
				fileEncSha256B64: fileSha256B64,
				mediaType: 'biz-cover-photo'
			})

			await query({
				tag: 'iq',
				attrs: {
					to: S_WHATSAPP_NET,
					type: 'set',
					xmlns: 'w:biz'
				},
				content: [
					{
						tag: 'business_profile',
						attrs: {
							v: '3',
							mutation_type: 'delta'
						},
						content: [
							{
								tag: 'cover_photo',
								attrs: { id: String(fbid), op: 'update', token: meta_hmac!, ts: String(ts) }
							}
						]
					}
				]
			})

			trace('business', 'updateCoverPhoto:return', { fbid })
			return fbid!
		} catch (error) {
			trace('business', 'updateCoverPhoto:error', { error: (error as Error).message })
			throw error
		}
	}

	const removeCoverPhoto = async (id: string) => {
		trace('business', 'removeCoverPhoto:enter', { id })
		try {
			const result = await query({
				tag: 'iq',
				attrs: {
					to: S_WHATSAPP_NET,
					type: 'set',
					xmlns: 'w:biz'
				},
				content: [
					{
						tag: 'business_profile',
						attrs: {
							v: '3',
							mutation_type: 'delta'
						},
						content: [
							{
								tag: 'cover_photo',
								attrs: { op: 'delete', id }
							}
						]
					}
				]
			})
			trace('business', 'removeCoverPhoto:return', { id })
			return result
		} catch (error) {
			trace('business', 'removeCoverPhoto:error', { id, error: (error as Error).message })
			throw error
		}
	}

	const getCatalog = async ({ jid, limit, cursor }: GetCatalogOptions) => {
		trace('business', 'getCatalog:enter', { jid, limit, hasCursor: !!cursor })
		try {
			jid = jid || authState.creds.me?.id
			jid = jidNormalizedUser(jid)

			const queryParamNodes: BinaryNode[] = [
				{
					tag: 'limit',
					attrs: {},
					content: Buffer.from((limit || 10).toString())
				},
				{
					tag: 'width',
					attrs: {},
					content: Buffer.from('100')
				},
				{
					tag: 'height',
					attrs: {},
					content: Buffer.from('100')
				}
			]

			if (cursor) {
				queryParamNodes.push({
					tag: 'after',
					attrs: {},
					content: cursor
				})
			}

			const result = await query({
				tag: 'iq',
				attrs: {
					to: S_WHATSAPP_NET,
					type: 'get',
					xmlns: 'w:biz:catalog'
				},
				content: [
					{
						tag: 'product_catalog',
						attrs: {
							jid,
							allow_shop_source: 'true'
						},
						content: queryParamNodes
					}
				]
			})
			const catalog = parseCatalogNode(result)
			trace('business', 'getCatalog:return', { jid })
			return catalog
		} catch (error) {
			trace('business', 'getCatalog:error', { error: (error as Error).message })
			throw error
		}
	}

	const getCollections = async (jid?: string, limit = 51) => {
		trace('business', 'getCollections:enter', { jid, limit })
		try {
			jid = jid || authState.creds.me?.id
			jid = jidNormalizedUser(jid)
			const result = await query({
				tag: 'iq',
				attrs: {
					to: S_WHATSAPP_NET,
					type: 'get',
					xmlns: 'w:biz:catalog',
					smax_id: '35'
				},
				content: [
					{
						tag: 'collections',
						attrs: {
							biz_jid: jid
						},
						content: [
							{
								tag: 'collection_limit',
								attrs: {},
								content: Buffer.from(limit.toString())
							},
							{
								tag: 'item_limit',
								attrs: {},
								content: Buffer.from(limit.toString())
							},
							{
								tag: 'width',
								attrs: {},
								content: Buffer.from('100')
							},
							{
								tag: 'height',
								attrs: {},
								content: Buffer.from('100')
							}
						]
					}
				]
			})

			const collections = parseCollectionsNode(result)
			trace('business', 'getCollections:return', { jid })
			return collections
		} catch (error) {
			trace('business', 'getCollections:error', { error: (error as Error).message })
			throw error
		}
	}

	const getOrderDetails = async (orderId: string, tokenBase64: string) => {
		trace('business', 'getOrderDetails:enter', { orderId })
		try {
			const result = await query({
				tag: 'iq',
				attrs: {
					to: S_WHATSAPP_NET,
					type: 'get',
					xmlns: 'fb:thrift_iq',
					smax_id: '5'
				},
				content: [
					{
						tag: 'order',
						attrs: {
							op: 'get',
							id: orderId
						},
						content: [
							{
								tag: 'image_dimensions',
								attrs: {},
								content: [
									{
										tag: 'width',
										attrs: {},
										content: Buffer.from('100')
									},
									{
										tag: 'height',
										attrs: {},
										content: Buffer.from('100')
									}
								]
							},
							{
								tag: 'token',
								attrs: {},
								content: Buffer.from(tokenBase64)
							}
						]
					}
				]
			})

			const orderDetails = parseOrderDetailsNode(result)
			trace('business', 'getOrderDetails:return', { orderId })
			return orderDetails
		} catch (error) {
			trace('business', 'getOrderDetails:error', { orderId, error: (error as Error).message })
			throw error
		}
	}

	const productUpdate = async (productId: string, update: ProductUpdate) => {
		trace('business', 'productUpdate:enter', { productId })
		try {
			update = await uploadingNecessaryImagesOfProduct(update, waUploadToServer)
			const editNode = toProductNode(productId, update)

			const result = await query({
				tag: 'iq',
				attrs: {
					to: S_WHATSAPP_NET,
					type: 'set',
					xmlns: 'w:biz:catalog'
				},
				content: [
					{
						tag: 'product_catalog_edit',
						attrs: { v: '1' },
						content: [
							editNode,
							{
								tag: 'width',
								attrs: {},
								content: '100'
							},
							{
								tag: 'height',
								attrs: {},
								content: '100'
							}
						]
					}
				]
			})

			const productCatalogEditNode = getBinaryNodeChild(result, 'product_catalog_edit')
			const productNode = getBinaryNodeChild(productCatalogEditNode, 'product')

			const product = parseProductNode(productNode!)
			trace('business', 'productUpdate:return', { productId })
			return product
		} catch (error) {
			trace('business', 'productUpdate:error', { productId, error: (error as Error).message })
			throw error
		}
	}

	const productCreate = async (create: ProductCreate) => {
		trace('business', 'productCreate:enter', { name: create.name })
		try {
			create.isHidden = !!create.isHidden
			create = await uploadingNecessaryImagesOfProduct(create, waUploadToServer)
			const createNode = toProductNode(undefined, create)

			const result = await query({
				tag: 'iq',
				attrs: {
					to: S_WHATSAPP_NET,
					type: 'set',
					xmlns: 'w:biz:catalog'
				},
				content: [
					{
						tag: 'product_catalog_add',
						attrs: { v: '1' },
						content: [
							createNode,
							{
								tag: 'width',
								attrs: {},
								content: '100'
							},
							{
								tag: 'height',
								attrs: {},
								content: '100'
							}
						]
					}
				]
			})

			const productCatalogAddNode = getBinaryNodeChild(result, 'product_catalog_add')
			const productNode = getBinaryNodeChild(productCatalogAddNode, 'product')

			const product = parseProductNode(productNode!)
			trace('business', 'productCreate:return', { name: create.name })
			return product
		} catch (error) {
			trace('business', 'productCreate:error', { error: (error as Error).message })
			throw error
		}
	}

	const productDelete = async (productIds: string[]) => {
		trace('business', 'productDelete:enter', { productCount: productIds.length })
		try {
			const result = await query({
				tag: 'iq',
				attrs: {
					to: S_WHATSAPP_NET,
					type: 'set',
					xmlns: 'w:biz:catalog'
				},
				content: [
					{
						tag: 'product_catalog_delete',
						attrs: { v: '1' },
						content: productIds.map(id => ({
							tag: 'product',
							attrs: {},
							content: [
								{
									tag: 'id',
									attrs: {},
									content: Buffer.from(id)
								}
							]
						}))
					}
				]
			})

			const productCatalogDelNode = getBinaryNodeChild(result, 'product_catalog_delete')
			const response = {
				deleted: +(productCatalogDelNode?.attrs.deleted_count || 0)
			}
			trace('business', 'productDelete:return', { deleted: response.deleted })
			return response
		} catch (error) {
			trace('business', 'productDelete:error', { error: (error as Error).message })
			throw error
		}
	}

	trace('business', 'makeBusinessSocket:return')
	return {
		...sock,
		logger: config.logger,
		getOrderDetails,
		getCatalog,
		getCollections,
		productCreate,
		productDelete,
		productUpdate,
		updateBussinesProfile,
		updateCoverPhoto,
		removeCoverPhoto
	}
}