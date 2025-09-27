/*eslint-disable no-undef */
const TradesAggregator = require('../src')
const TxCache = require('../src/cache')
const RpcConnector = require('../src/rpc-connector')
const {getPoolContracts, getPoolsData} = require('../src/pools')
const {getDexData} = require('../src/dex')

jest.mock('../src/rpc-connector')
jest.mock('../src/cache')
jest.mock('../src/dex', () => ({
    getDexData: jest.fn()
}))
jest.mock('../src/pools', () => ({
    getPoolsData: jest.fn(),
    getPoolContracts: jest.fn()
}))
jest.mock('../src/utils', () => ({
    convertToStellarAsset: jest.fn(a => a),
    getVWAP: jest.fn((volume, quoteVolume) => volume && quoteVolume ? 100n : 0n)
}))

describe('TradesAggregator', () => {
    let aggregator

    beforeEach(() => {
        aggregator = new TradesAggregator()
        RpcConnector.mockClear()
        TxCache.mockClear()
    })

    test('init throws on missing rpcUrls', async () => {
        await expect(aggregator.init([], 'network')).rejects.toThrow('Invalid RPC URLs')
        await expect(aggregator.init(null, 'network')).rejects.toThrow('Invalid RPC URLs')
    })

    test('init throws on missing network', async () => {
        await expect(aggregator.init(['url'], null)).rejects.toThrow('Invalid network passphrase')
    })

    test('init sets up connector, network, cache', async () => {
        await aggregator.init(['url1', 'url2'], 'testnet')
        expect(aggregator.connector).toBeInstanceOf(RpcConnector)
        expect(aggregator.network).toBe('testnet')
        expect(aggregator.cache).toBeInstanceOf(TxCache)
    })

    test('aggregateTrades returns correct structure', async () => {
        await aggregator.init(['url'], 'network')
        getPoolContracts.mockResolvedValue(['contract1', 'contract2'])
        aggregator.cache.updateCache = jest.fn().mockResolvedValue()
        getDexData.mockReturnValue([
            [{asset: {type: 1, code: 'USD'}, volume: 5n, quoteVolume: 20n, ts: 1000}, {asset: {type: 1, code: 'EUR'}, volume: 15n, quoteVolume: 60n, ts: 1000}],
            [{asset: {type: 1, code: 'USD'}, volume: 10n, quoteVolume: 20n, ts: 2000}, {asset: {type: 1, code: 'EUR'}, volume: 30n, quoteVolume: 60n, ts: 2000}]
        ])
        getPoolsData.mockReturnValue([
            [{asset: {type: 1, code: 'USD'}, volume: 5n, quoteVolume: 10n, ts: 1000}, {asset: {type: 1, code: 'EUR'}, volume: 15n, quoteVolume: 30n, ts: 1000}],
            [{asset: {type: 1, code: 'USD'}, volume: 10n, quoteVolume: 20n, ts: 2000}, {asset: {type: 1, code: 'EUR'}, volume: 30n, quoteVolume: 60n, ts: 2000}]
        ])

        const options = {
            baseAsset: {type: 1, code: 'XLM'},
            assets: [{type: 1, code: 'USD'}, {type: 1, code: 'EUR'}],
            from: 1000,
            period: 1000,
            limit: 2
        }
        const result = await aggregator.aggregateTrades(options)
        expect(result).toHaveLength(2)
        expect(result[0]).toHaveLength(2)
        expect(result[0][0]).toEqual({price: 100n, ts: 1000, type: 'price'})
        expect(result[1][1]).toEqual({price: 100n, ts: 2000, type: 'price'})
    })

    test('aggregateTrades handles empty data', async () => {
        await aggregator.init(['url'], 'network')
        getPoolContracts.mockResolvedValue([])
        aggregator.cache.updateCache = jest.fn().mockResolvedValue()
        getDexData.mockReturnValue([null, []])
        getPoolsData.mockReturnValue([[], null])

        const options = {
            baseAsset: {type: 1, code: 'XLM'},
            assets: [{type: 1, code: 'USD'}],
            from: 0,
            period: 1000,
            limit: 2
        }
        const result = await aggregator.aggregateTrades(options)
        expect(result).toHaveLength(2)
        expect(result[0][0].price).toBe(0n)
    })
})
