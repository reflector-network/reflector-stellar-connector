/*eslint-disable no-undef */
const PoolsDataAggregator = require('../src/pools/pools-data-aggregator')
const {resolvePoolGuards} = require('../src/pools/pool-guards')
const {encodeAssetContractId} = require('../src/utils')

console.debug = jest.fn()
console.info = jest.fn()
console.warn = jest.fn()
console.error = jest.fn()
console.log = jest.fn()

const NETWORK = 'Public Global Stellar Network ; September 2015'
const BASE = 'XLM'
const ASSET = 'AQUA:GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA'
const BASE_TOKEN = encodeAssetContractId(BASE, NETWORK)
const ASSET_TOKEN = encodeAssetContractId(ASSET, NETWORK)
const unit = 10n ** 14n

/**
 * @param {string} poolId - pool id
 * @param {number} base - base-side reserve in whole units
 * @param {number} quote - quote-side reserve in whole units
 * @param {boolean} [reversed] - true when the base token is the pool's second token
 * @returns {{poolId: string, tokens: string[], reserves: BigInt[]}}
 */
function pool(poolId, base, quote, reversed = false) {
    const reserves = [BigInt(base) * unit, BigInt(quote) * unit]
    if (reversed)
        return {poolId, tokens: [ASSET_TOKEN, BASE_TOKEN], reserves: [reserves[1], reserves[0]]}
    return {poolId, tokens: [BASE_TOKEN, ASSET_TOKEN], reserves}
}

describe('PoolsDataAggregator', () => {
    beforeEach(() => jest.clearAllMocks())

    test('sums pools in either token order', () => {
        const aggregator = new PoolsDataAggregator(BASE, [ASSET], NETWORK, 1780009200, resolvePoolGuards())
        //the second pool lists the base token second, so its reserves are read the other way round
        aggregator.processTokenReserves([pool('a', 5000, 10000), pool('b', 5000, 10000, true)])
        expect(aggregator.volumes[0].volume).toBe(10000n * unit)
        expect(aggregator.volumes[0].quoteVolume).toBe(20000n * unit)
    })

    test('a pool that dominates the period contributes all of its reserves', () => {
        const aggregator = new PoolsDataAggregator(BASE, [ASSET], NETWORK, 1780009200, resolvePoolGuards())
        aggregator.processTokenReserves([pool('big', 9000, 18000), pool('small', 1000, 2000)])
        //nothing trims the deepest pool: a party holding the majority of floor-surviving depth sets the price
        expect(aggregator.volumes[0].volume).toBe(10000n * unit)
        expect(aggregator.volumes[0].quoteVolume).toBe(20000n * unit)
    })

    test('a nine-unit pool cannot price the asset', () => {
        const aggregator = new PoolsDataAggregator(BASE, [ASSET], NETWORK, 1780009200, resolvePoolGuards())
        aggregator.processTokenReserves([{poolId: 'tiny', tokens: [BASE_TOKEN, ASSET_TOKEN], reserves: [9n * unit, 45n * unit / 10000n]}])
        expect(aggregator.volumes[0].volume).toBe(0n)
        expect(aggregator.volumes[0].quoteVolume).toBe(0n)
    })

    test('a pool priced far from the rest is summed with them, not filtered out', () => {
        const aggregator = new PoolsDataAggregator(BASE, [ASSET], NETWORK, 1780009200, resolvePoolGuards())
        aggregator.processTokenReserves([pool('a', 5000, 10000), pool('b', 5000, 10000), pool('skew', 1000, 500)])
        //0.5, 0.5 and 2.0, all above the floor: the aggregate is volume-weighted over all three
        expect(aggregator.volumes[0].volume).toBe(11000n * unit)
        expect(aggregator.volumes[0].quoteVolume).toBe(20500n * unit)
    })

    test('a pool the floor admits can still contribute nothing', () => {
        //the floor decides which pools reach the accumulator, not which ones land in the sum. The accumulator
        //drops a pool with either side below MIN_VOLUME (1e9 raw, 1e-5 whole units), so a pool far above the
        //floor on the base side and one raw unit under MIN_VOLUME on the quote side is accepted by the guard and
        //still adds nothing at all. One raw unit more on the quote side and the whole pool lands
        const below = new PoolsDataAggregator(BASE, [ASSET], NETWORK, 1780009200, resolvePoolGuards())
        below.processTokenReserves([{poolId: 'thinQuote', tokens: [BASE_TOKEN, ASSET_TOKEN], reserves: [200n * unit, 999999999n]}])
        const applied = console.debug.mock.calls.map(c => c[0]).find(a => a && a.msg === 'Pool volumes applied')
        expect(applied.rejected).toEqual([]) //the floor let it through
        expect(below.volumes[0].volume).toBe(0n) //and it contributed nothing anyway
        expect(below.volumes[0].quoteVolume).toBe(0n)
        const at = new PoolsDataAggregator(BASE, [ASSET], NETWORK, 1780009200, resolvePoolGuards())
        at.processTokenReserves([{poolId: 'thinQuote', tokens: [BASE_TOKEN, ASSET_TOKEN], reserves: [200n * unit, 1000000000n]}])
        expect(at.volumes[0].volume).toBe(200n * unit)
        expect(at.volumes[0].quoteVolume).toBe(1000000000n)
    })

    test('a floor rejection alone stays at debug', () => {
        //the Aqua list is full of dust pools, so raising the level on the one rejection that fires for every
        //asset every period would put a line per asset per period into a 2 MB x 20 retention window and destroy
        //the post-mortem this logging exists for
        const aggregator = new PoolsDataAggregator(BASE, [ASSET], NETWORK, 1780009200, resolvePoolGuards())
        aggregator.processTokenReserves([pool('deep', 5000, 10000), {poolId: 'dust', tokens: [BASE_TOKEN, ASSET_TOKEN], reserves: [9n * unit, 18n * unit]}])
        expect(console.info).not.toHaveBeenCalled()
        expect(console.debug).toHaveBeenCalledWith(expect.objectContaining({msg: 'Pool volumes applied'}))
    })

    test('a malformed pool is named as malformed, and that raises the line off debug', () => {
        //a zero quote reserve is malformed, not "below the liquidity floor" - the one reason the level rule
        //exempts - so a broken feed is not logged as quietly as the dust it is nothing like
        const aggregator = new PoolsDataAggregator(BASE, [ASSET], NETWORK, 1780009200, resolvePoolGuards())
        aggregator.processTokenReserves([
            pool('deep', 5000, 10000),
            {poolId: 'broken', tokens: [BASE_TOKEN, ASSET_TOKEN], reserves: [1000n * unit, 0n]}
        ])
        const applied = console.info.mock.calls.map(c => c[0]).find(a => a && a.msg === 'Pool volumes applied')
        expect(applied.rejected).toEqual([{poolId: 'broken', reason: 'malformed pool reserves'}])
        expect(console.debug).not.toHaveBeenCalledWith(expect.objectContaining({msg: 'Pool volumes applied'}))
        expect(aggregator.volumes[0].volume).toBe(5000n * unit)
    })

    test('untracked assets and pools without the base token are ignored', () => {
        const aggregator = new PoolsDataAggregator(BASE, [ASSET], NETWORK, 1780009200, resolvePoolGuards())
        aggregator.processTokenReserves([
            {poolId: 'x', tokens: ['CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526', ASSET_TOKEN], reserves: [5000n * unit, 10000n * unit]},
            {poolId: 'y', tokens: [BASE_TOKEN, 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526'], reserves: [5000n * unit, 10000n * unit]}
        ])
        expect(aggregator.volumes[0].volume).toBe(0n)
    })
})
