/*eslint-disable no-undef */
const {Networks} = require('@stellar/stellar-sdk')
const AquaPoolProvider = require('../src/pools/aqua/aqua-pool-provider')
const StellarLiquidityPoolProvider = require('../src/pools/stellar/stellar-liquidity-pool-provider')
const SushiPoolProvider = require('../src/pools/sushi/sushi-pool-provider')
const {getPoolContracts, resolvePoolSources} = require('../src/pools')
const {poolPairKey} = require('../src/utils')

console.debug = jest.fn()
console.info = jest.fn()
console.warn = jest.fn()
console.error = jest.fn()
console.log = jest.fn()

const NETWORK = Networks.PUBLIC
const BASE = 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
const A = 'AQUA:GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA'
const B = 'yETH:GDYQNEF2UWTK4L6HITMT53MZ6F5QWO3Q4UVE6SCGC4OMEQIZQQDERQFD'
const noPools = () => new Map([[A, []], [B, []]])

/**
 * @param {Array<{provider: object, settings: object}>} enabled - resolvePoolSources result
 * @returns {Array<[string, object]>} provider type and settings of each entry
 */
function describeEnabled(enabled) {
    return enabled.map(({provider, settings}) => [provider.type, settings])
}

describe('resolvePoolSources', () => {
    beforeEach(() => jest.clearAllMocks())

    test('absent sources run every provider with default settings', () => {
        expect(describeEnabled(resolvePoolSources(undefined))).toEqual([['AQUA', {}], ['STELLAR_LIQUIDITY', {}], ['SUSHISWAP', {}]])
        expect(console.warn).not.toHaveBeenCalled()
    })

    test('an object runs only the providers it names, with their settings', () => {
        const sources = {AQUA: {aquaListUrl: 'https://backup.aqua.network/p/?count=500'}, SUSHISWAP: {}}
        expect(describeEnabled(resolvePoolSources(sources))).toEqual([['AQUA', {aquaListUrl: 'https://backup.aqua.network/p/?count=500'}], ['SUSHISWAP', {}]])
    })

    test('an empty object runs no provider', () => {
        expect(resolvePoolSources({})).toEqual([])
    })

    test('an array of names runs those providers with default settings', () => {
        expect(describeEnabled(resolvePoolSources(['STELLAR_LIQUIDITY']))).toEqual([['STELLAR_LIQUIDITY', {}]])
    })

    test('unknown names are named in one warning and ignored', () => {
        expect(describeEnabled(resolvePoolSources({AQUA: {}, UNISWAP: {}, CURVE: {}}))).toEqual([['AQUA', {}]])
        expect(console.warn).toHaveBeenCalledTimes(1)
        expect(console.warn).toHaveBeenCalledWith(expect.objectContaining({msg: 'Unknown pool providers ignored', providers: ['UNISWAP', 'CURVE']}))
    })

    test('sources of another type are named in a warning and the defaults run', () => {
        expect(describeEnabled(resolvePoolSources('AQUA'))).toEqual([['AQUA', {}], ['STELLAR_LIQUIDITY', {}], ['SUSHISWAP', {}]])
        expect(console.warn).toHaveBeenCalledWith(expect.objectContaining({msg: 'Pool provider sources must be an object or an array - using all providers'}))
    })

    //Review Focus
    test('a provider entry that is null or not an object runs with default settings', () => {
        expect(describeEnabled(resolvePoolSources({AQUA: null, SUSHISWAP: 'x'}))).toEqual([['AQUA', {}], ['SUSHISWAP', {}]])
    })
})

describe('getPoolContracts', () => {
    let aqua
    let classic
    let sushi

    beforeEach(() => {
        jest.clearAllMocks()
        aqua = jest.spyOn(AquaPoolProvider.prototype, 'getTargetPools').mockResolvedValue(noPools())
        classic = jest.spyOn(StellarLiquidityPoolProvider.prototype, 'getTargetPools').mockResolvedValue(noPools())
        sushi = jest.spyOn(SushiPoolProvider.prototype, 'getTargetPools').mockResolvedValue(noPools())
    })

    afterEach(() => jest.restoreAllMocks())

    test('an asset with pools on a working provider stays valid while another provider fails', async () => {
        aqua.mockResolvedValue(new Map([[A, ['POOL_A']], [B, []]]))
        sushi.mockRejectedValue(new Error('rpc down'))
        const {contracts, validAssets} = await getPoolContracts(BASE, [A, B], NETWORK, resolvePoolSources(undefined))
        expect([...contracts.keys()]).toEqual(['POOL_A'])
        expect(contracts.get('POOL_A')).toBeInstanceOf(AquaPoolProvider)
        expect([...validAssets]).toEqual([A])
        expect(console.error).toHaveBeenCalledWith(expect.objectContaining({msg: 'Pool discovery failed', provider: 'SUSHISWAP'}))
    })

    test('an asset without pools is valid when every provider answered', async () => {
        const {validAssets} = await getPoolContracts(BASE, [A, B], NETWORK, resolvePoolSources(undefined))
        expect([...validAssets]).toEqual([A, B])
    })

    test('with no provider enabled every asset is valid and there are no pools', async () => {
        const {contracts, validAssets} = await getPoolContracts(BASE, [A, B], NETWORK, [])
        expect(contracts.size).toBe(0)
        expect([...validAssets]).toEqual([A, B])
    })

    test('a provider that is not enabled is not asked, and settings reach the enabled ones', async () => {
        const factoryContract = 'CD3KRKGDRVWPXVB3VXLUMQKMX6XZ6Q2H334IVZD4XXNAMKSRVQL5GLYF'
        await getPoolContracts(BASE, [A, B], NETWORK, resolvePoolSources({SUSHISWAP: {factoryContract}}))
        expect(aqua).not.toHaveBeenCalled()
        expect(classic).not.toHaveBeenCalled()
        expect(sushi).toHaveBeenCalledWith(BASE, [A, B], NETWORK, {factoryContract})
    })

    test('poolPairKey joins the base and the asset', () => {
        expect(poolPairKey(BASE, A)).toBe(`${BASE}|${A}`)
    })
})
