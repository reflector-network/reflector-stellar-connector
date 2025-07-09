/*eslint-disable no-undef */
const {Asset} = require('@stellar/stellar-sdk')
const {aggregateTrades} = require('../src/index')
const RpcConnector = require('../src/rpc-connector')
const {getDexData} = require('../src/dex')
const {getPoolsData} = require('../src/pools')
const {adjustPrecision} = require('../src/utils')

jest.mock('../src/rpc-connector')
jest.mock('../src/dex')
jest.mock('../src/pools')

function serializeWithBigInt(obj) {
    return JSON.parse(JSON.stringify(obj, (key, value) => {
        if (typeof value === 'bigint') {
            return value.toString()
        }
        return value
    }))
}

describe('aggregateTrades', () => {
    beforeEach(() => {
        jest.clearAllMocks()
    })

    test('should aggregate trades and pools data successfully', async () => {
        const mockRpcInstance = {}

        RpcConnector.mockImplementation(() => mockRpcInstance)

        getDexData.mockResolvedValue(Promise.resolve([
            [{volume: adjustPrecision(100n, 0), quoteVolume: adjustPrecision(200n, 0), ts: 1620000000}],
            [{volume: adjustPrecision(150n, 0), quoteVolume: adjustPrecision(300n, 0), ts: 1620003600}]
        ]))
        getPoolsData.mockResolvedValue([
            null,
            [{volume: adjustPrecision(75n, 0), quoteVolume: adjustPrecision(150n, 0)}]
        ])

        const options = {
            rpcUrl: 'http://localhost:8003',
            network: 'Public Global Stellar Network ; September 2015',
            baseAsset: {type: 1, code: 'XLM'},
            assets: [{type: 1, code: 'AQUA:GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA'}],
            from: 1620000000,
            period: 3600,
            limit: 2
        }

        const result = await aggregateTrades(options)

        expect(serializeWithBigInt(result)).toEqual(serializeWithBigInt([
            [{price: adjustPrecision(2n, 0).toString(), ts: 1620000000, type: 'price'}],
            [{price: adjustPrecision(2n, 0).toString(), ts: 1620003600, type: 'price'}]
        ]))
    }, 30000)

    test('should handle empty trades and pools data', async () => {
        RpcConnector.mockImplementation(() => ({}))
        getDexData.mockResolvedValue([[], []])
        getPoolsData.mockResolvedValue([[], []])

        const options = {
            rpcUrl: 'https://mock-rpc-url',
            baseAsset: {type: 1, code: 'XLM'},
            assets: [{type: 1, code: 'USD:GDPKQ2TSNJOFSEE7XSUXPWRP27H6GFGLWD7JCHNEYYWQVGFA543EVBVT'}],
            from: 1620000000,
            period: 3600,
            limit: 2
        }

        const result = await aggregateTrades(options)

        expect(result).toEqual([
            [{price: 0n, ts: 1620000000, type: 'price'}],
            [{price: 0n, ts: 1620003600, type: 'price'}]
        ])
    })
})