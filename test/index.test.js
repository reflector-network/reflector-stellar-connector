/*eslint-disable no-undef */
const {aggregateTrades} = require('../src/index')
const RpcConnector = require('../src/rpc-connector')
const {getDexData} = require('../src/dex')
const {getPoolsData} = require('../src/pools')
const {convertToStellarAsset, getVWAP, adjustPrecision} = require('../src/utils')

jest.mock('../src/rpc-connector')
jest.mock('../src/dex')
jest.mock('../src/pools')

describe('aggregateTrades', () => {
    beforeEach(() => {
        jest.clearAllMocks()
    })

    test('should aggregate trades and pools data successfully', async () => {
        //Mock dependencies
        const mockRpcInstance = {}
        RpcConnector.mockImplementation(() => mockRpcInstance)

        getDexData.mockResolvedValue([
            [{volume: adjustPrecision(100n, 0), quoteVolume: adjustPrecision(200n, 0), ts: 1620000000}],
            [{volume: adjustPrecision(150n, 0), quoteVolume: adjustPrecision(300n, 0), ts: 1620003600}]
        ])
        getPoolsData.mockResolvedValue([
            [{volume: adjustPrecision(50n, 0), quoteVolume: adjustPrecision(100n, 0)}],
            [{volume: adjustPrecision(75n, 0), quoteVolume: adjustPrecision(150n, 0)}]
        ])

        //Input options
        const options = {
            rpcUrl: 'https://mock-rpc-url',
            baseAsset: {type: 1, code: 'XLM'},
            assets: [{type: 1, code: 'USD:GDPKQ2TSNJOFSEE7XSUXPWRP27H6GFGLWD7JCHNEYYWQVGFA543EVBVT'}],
            from: 1620000000,
            period: 3600,
            limit: 2
        }

        //Call the function
        const result = await aggregateTrades(options)

        //Assertions
        expect(RpcConnector).toHaveBeenCalledWith('https://mock-rpc-url', undefined)
        expect(result).toEqual([
            [{price: adjustPrecision(2n, 0), ts: 1620000000, type: 'price'}],
            [{price: adjustPrecision(2n, 0), ts: 1620003600, type: 'price'}]
        ])
    })

    test('should handle empty trades and pools data', async () => {
        //Mock dependencies
        RpcConnector.mockImplementation(() => ({}))
        getDexData.mockResolvedValue([[], []])
        getPoolsData.mockResolvedValue([[], []])

        //Input options
        const options = {
            rpcUrl: 'https://mock-rpc-url',
            baseAsset: {type: 1, code: 'XLM'},
            assets: [{type: 1, code: 'USD:GDPKQ2TSNJOFSEE7XSUXPWRP27H6GFGLWD7JCHNEYYWQVGFA543EVBVT'}],
            from: 1620000000,
            period: 3600,
            limit: 2
        }

        //Call the function
        const result = await aggregateTrades(options)

        //Assertions
        expect(result).toEqual([
            [{price: 0n, ts: 1620000000, type: 'price'}],
            [{price: 0n, ts: 1620003600, type: 'price'}]
        ])
    })
})