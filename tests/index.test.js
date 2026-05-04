/*eslint-disable no-undef */
const os = require('os')
const path = require('path')
const fs = require('fs')
const StellarProvider = require('../src')
const TxCache = require('../src/cache')
const RpcConnector = require('../src/rpc-connector')
const {getPoolContracts, getPoolVolumes, configure: configurePools} = require('../src/pools')
const {getDexVolumes} = require('../src/dex')
const {getVWAP, scaleValue, TARGET_DECIMALS} = require('../src/utils')

jest.mock('../src/rpc-connector')
jest.mock('../src/cache')
jest.mock('../src/dex', () => ({
    getDexVolumes: jest.fn()
}))
jest.mock('../src/pools', () => ({
    getPoolVolumes: jest.fn(),
    getPoolContracts: jest.fn(),
    configure: jest.fn()
}))
jest.mock('../src/utils', () => {
    const actual = jest.requireActual('../src/utils')
    return {
        ...actual,
        convertToStellarAsset: jest.fn(a => a)
    }
})
//mock console
console.debug = jest.fn()
console.info = jest.fn()
console.warn = jest.fn()
console.error = jest.fn()
console.log = jest.fn()

describe('StellarProvider', () => {
    /**@type {StellarProvider} */
    let provider
    let cacheDir

    beforeEach(() => {
        jest.clearAllMocks()
        provider = new StellarProvider()
        RpcConnector.mockClear()
        TxCache.mockClear()
        cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-provider-test-'))
    })

    afterEach(() => {
        fs.rmSync(cacheDir, {recursive: true, force: true})
    })

    test('init throws on missing rpcUrls', async () => {
        await expect(provider.init({rpcUrls: [], network: 'network', cacheDir})).rejects.toThrow('Invalid RPC URLs')
        await expect(provider.init({rpcUrls: null, network: 'network', cacheDir})).rejects.toThrow('Invalid RPC URLs')
    })

    test('init throws on missing network', async () => {
        await expect(provider.init({rpcUrls: ['url'], network: null, cacheDir})).rejects.toThrow('Invalid network passphrase')
    })

    test('init throws on missing cacheDir', async () => {
        await expect(provider.init({rpcUrls: ['url'], network: 'network'})).rejects.toThrow('Invalid cache directory')
        await expect(provider.init({rpcUrls: ['url'], network: 'network', cacheDir: ''})).rejects.toThrow('Invalid cache directory')
    })

    test('init sets up connector, network, cache, and configures pool providers', async () => {
        await provider.init({rpcUrls: ['url1', 'url2'], network: 'testnet', cacheDir})
        expect(provider.connector).toBeInstanceOf(RpcConnector)
        expect(provider.cache).toBeInstanceOf(TxCache)
        expect(configurePools).toHaveBeenCalledWith(cacheDir)
    })

    test('getData returns correct structure', async () => {
        await provider.init({rpcUrls: ['url'], network: 'network', cacheDir})
        getPoolContracts.mockResolvedValue(new Map())
        provider.cache.updateCache = jest.fn().mockResolvedValue()
        getDexVolumes.mockReturnValue([
            [{asset: {type: 1, code: 'USD'}, volume: 5n, quoteVolume: 20n, ts: 1000}, {asset: {type: 1, code: 'EUR'}, volume: 15n, quoteVolume: 60n, ts: 1000}],
            [{asset: {type: 1, code: 'USD'}, volume: 10n, quoteVolume: 20n, ts: 2000}, {asset: {type: 1, code: 'EUR'}, volume: 30n, quoteVolume: 60n, ts: 2000}]
        ])
        getPoolVolumes.mockReturnValue([
            [{asset: {type: 1, code: 'USD'}, volume: 5n, quoteVolume: 10n, ts: 1000}, {asset: {type: 1, code: 'EUR'}, volume: 15n, quoteVolume: 30n, ts: 1000}],
            [{asset: {type: 1, code: 'USD'}, volume: 10n, quoteVolume: 20n, ts: 2000}, {asset: {type: 1, code: 'EUR'}, volume: 30n, quoteVolume: 60n, ts: 2000}]
        ])

        const options = {
            baseAsset: 'XLM',
            assets: ['USD:GISSUER', 'EUR:GISSUER'],
            from: 1000,
            period: 1000,
            count: 2
        }
        const result = await provider.getPriceData(options)
        expect(result).toHaveLength(2)
        expect(result[0]).toHaveLength(2)
        //period 0, USD: dex(5/20) + pool(5/10) => volume=10, quoteVolume=30 => getVWAP(10n, 30n)
        expect(result[0][0]).toEqual([{price: getVWAP(10n, 30n), ts: 1000, type: 'price'}])
        //period 1, EUR: dex(30/60) + pool(30/60) => volume=60, quoteVolume=120 => getVWAP(60n, 120n)
        expect(result[1][1]).toEqual([{price: getVWAP(60n, 120n), ts: 2000, type: 'price'}])
    })

    test('getPriceData handles empty data', async () => {
        await provider.init({rpcUrls: ['url'], network: 'network', cacheDir})
        getPoolContracts.mockResolvedValue(new Map())
        provider.cache.updateCache = jest.fn().mockResolvedValue()
        getDexVolumes.mockReturnValue([null, []])
        getPoolVolumes.mockReturnValue([[], null])

        const options = {
            baseAsset: 'XLM',
            assets: ['USD:GISSUER'],
            from: 0,
            period: 1000,
            count: 2
        }
        const result = await provider.getPriceData(options)
        expect(result).toHaveLength(2)
        expect(result[0][0][0].price).toBe(0n)
    })

    test('getPriceData fetches XLM cross-price data when baseAsset is not XLM', async () => {
        await provider.init({rpcUrls: ['url'], network: 'network', cacheDir})
        const usdcBase = 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
        const asset = 'TOKEN:GISSUER'
        getPoolContracts.mockResolvedValue(new Map())
        provider.cache.updateCache = jest.fn().mockResolvedValue()
        //no direct USDC data for the token
        getDexVolumes.mockReturnValue([[null]])
        getPoolVolumes.mockReturnValue([[null]])

        const crossAssets = ['XLM']
        const result = await provider.getPriceData({
            baseAsset: usdcBase,
            assets: [asset],
            from: 1000,
            period: 1000,
            count: 1,
            crossAssets
        })
        //getPoolContracts should be called once for USDC base + once per cross asset (XLM, yUSDC)
        expect(getPoolContracts).toHaveBeenCalledTimes(crossAssets.length + 1)
        expect(getPoolContracts).toHaveBeenCalledWith('XLM', [usdcBase, asset], undefined)
        //getDexVolumes should be called once for USDC base + once per cross asset (XLM, yUSDC)
        expect(getDexVolumes).toHaveBeenCalledTimes(crossAssets.length + 1)
        expect(getDexVolumes).toHaveBeenCalledWith(expect.anything(), 'XLM', [usdcBase, asset], undefined, 1000, 1000, 1)
        expect(result).toHaveLength(1)
    })

    test('getPriceData does not fetch XLM cross-price data when baseAsset is XLM', async () => {
        await provider.init({rpcUrls: ['url'], network: 'network', cacheDir})
        getPoolContracts.mockResolvedValue(new Map())
        provider.cache.updateCache = jest.fn().mockResolvedValue()
        getDexVolumes.mockReturnValue([[null]])
        getPoolVolumes.mockReturnValue([[null]])

        await provider.getPriceData({
            baseAsset: 'XLM',
            assets: ['TOKEN:GISSUER'],
            from: 1000,
            period: 1000,
            count: 1,
            crossAssets: ['XLM']
        })
        //getPoolContracts should be called once for XLM base + once for yUSDC cross asset (XLM excluded from cross since it's the base)
        expect(getPoolContracts).toHaveBeenCalledTimes(1)
        expect(getDexVolumes).toHaveBeenCalledTimes(1)
    })

    test('getCrossVolumes incorporates XLM price into asset volumes', async () => {
        await provider.init({rpcUrls: ['url'], network: 'network', cacheDir})
        const usdcBase = 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
        const asset = 'TOKEN:GISSUER'
        getPoolContracts.mockResolvedValue(new Map())
        provider.cache.updateCache = jest.fn().mockResolvedValue()

        //no direct USDC pair for the token
        getDexVolumes.mockImplementation((_cache, baseAsset) => {
            if (baseAsset === 'XLM') {
                return [[
                    {volume: 1000n, quoteVolume: 500n}, //XLM/USDC accumulator
                    {volume: 2000n, quoteVolume: 800n}  //XLM/TOKEN accumulator
                ]]
            }
            return [[null]] //no direct USDC data
        })
        getPoolVolumes.mockReturnValue([[null]])

        const result = await provider.getPriceData({
            baseAsset: usdcBase,
            assets: [asset],
            from: 1000,
            period: 1000,
            count: 1,
            crossAssets: ['XLM']
        })
        //price should be non-zero because XLM cross-price provides data
        expect(result[0][0][0].price).toBeGreaterThan(0n)
    })
})
