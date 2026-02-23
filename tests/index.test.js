/*eslint-disable no-undef */
const StellarProvider = require('../src')
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
//mock console
console.debug = jest.fn()
console.info = jest.fn()
console.warn = jest.fn()
console.error = jest.fn()
console.log = jest.fn()

describe('StellarProvider', () => {
    let provider

    beforeEach(() => {
        provider = new StellarProvider()
        RpcConnector.mockClear()
        TxCache.mockClear()
    })

    test('init throws on missing rpcUrls', async () => {
        await expect(provider.init({rpcUrls: [], network: 'network'})).rejects.toThrow('Invalid RPC URLs')
        await expect(provider.init({rpcUrls: null, network: 'network'})).rejects.toThrow('Invalid RPC URLs')
    })

    test('init throws on missing network', async () => {
        await expect(provider.init({rpcUrls: ['url'], network: null})).rejects.toThrow('Invalid network passphrase')
    })

    test('init sets up connector, network, cache', async () => {
        await provider.init({rpcUrls: ['url1', 'url2'], network: 'testnet'})
        expect(provider.connector).toBeInstanceOf(RpcConnector)
        expect(provider.network).toBe('testnet')
        expect(provider.cache).toBeInstanceOf(TxCache)
    })

    test('getData returns correct structure', async () => {
        await provider.init({rpcUrls: ['url'], network: 'network'})
        getPoolContracts.mockResolvedValue(['contract1', 'contract2'])
        provider.cache.updateCache = jest.fn().mockResolvedValue()
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
            count: 2
        }
        const result = await provider.getPriceData(options)
        expect(result).toHaveLength(2)
        expect(result[0]).toHaveLength(2)
        expect(result[0][0]).toEqual([{price: 100n, ts: 1000, type: 'price'}])
        expect(result[1][1]).toEqual([{price: 100n, ts: 2000, type: 'price'}])
    })

    test('getPriceData handles empty data', async () => {
        await provider.init({rpcUrls: ['url'], network: 'network'})
        getPoolContracts.mockResolvedValue([])
        provider.cache.updateCache = jest.fn().mockResolvedValue()
        getDexData.mockReturnValue([null, []])
        getPoolsData.mockReturnValue([[], null])

        const options = {
            baseAsset: {type: 1, code: 'XLM'},
            assets: [{type: 1, code: 'USD'}],
            from: 0,
            period: 1000,
            count: 2
        }
        const result = await provider.getPriceData(options)
        expect(result).toHaveLength(2)
        expect(result[0][0][0].price).toBe(0n)
    })
})
