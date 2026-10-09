/*eslint-disable no-undef */
const {getPoolVolumes} = require('../src/pools')
const {resolvePoolGuards} = require('../src/pools/pool-guards')
const {encodeAssetContractId} = require('../src/utils')

console.debug = jest.fn()
console.info = jest.fn()
console.warn = jest.fn()
console.error = jest.fn()
console.log = jest.fn()

const NETWORK = 'Public Global Stellar Network ; September 2015'
const BASE = 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
const ASSET = 'AQUA:GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA'
const BASE_TOKEN = encodeAssetContractId(BASE, NETWORK)
const ASSET_TOKEN = encodeAssetContractId(ASSET, NETWORK)
const unit = 10n ** 14n
const FROM = 1780009200

/**
 * @param {string} poolId - pool id
 * @param {number} base - base-side reserve in whole units
 * @param {number} quote - quote-side reserve in whole units
 * @returns {{poolId: string, tokens: string[], reserves: BigInt[]}}
 */
function pool(poolId, base, quote) {
    return {poolId, tokens: [BASE_TOKEN, ASSET_TOKEN], reserves: [BigInt(base) * unit, BigInt(quote) * unit]}
}

/**
 * @param {object[]} pools - pools for the single period
 * @returns {{getPoolVolumesForPeriod: function}}
 */
function createCache(pools) {
    return {period: 60, getPoolVolumesForPeriod: jest.fn(() => pools)}
}

describe('getPoolVolumes guard wiring', () => {
    beforeEach(() => jest.clearAllMocks())

    test('a nine-unit pool does not set the price while a deep pool does', () => {
        const cache = createCache([
            {poolId: 'tiny', tokens: [BASE_TOKEN, ASSET_TOKEN], reserves: [9n * unit, 45n * unit / 10000n]},
            pool('deep', 5000, 10000)
        ])
        const [period] = getPoolVolumes(cache, BASE, [ASSET], NETWORK, FROM, 60, 1, resolvePoolGuards())
        expect(period[0].volume).toBe(5000n * unit)
        expect(period[0].quoteVolume).toBe(10000n * unit)
    })

    test('every pool above the floor is summed, and only the floor decides which', () => {
        //the whole pipeline in one period: three pools spread 4x in price, the deepest of them 60% of the
        //depth, and one pool a unit of depth short of the floor. All three above the floor are summed by their
        //reserves and none of them is trimmed, so the published pair is the volume-weighted aggregate of the
        //floor survivors and nothing else
        const cache = createCache([pool('low', 5000, 10000), pool('high', 1000, 500), pool('mid', 300, 300), pool('dust', 99, 198)])
        const [period] = getPoolVolumes(cache, BASE, [ASSET], NETWORK, FROM, 60, 1, resolvePoolGuards())
        expect(period[0].volume).toBe(6300n * unit)
        expect(period[0].quoteVolume).toBe(10800n * unit)
        //the sub-floor pool contributes nothing at all: drop it and the pair is unchanged
        const withoutDust = createCache([pool('low', 5000, 10000), pool('high', 1000, 500), pool('mid', 300, 300)])
        const [same] = getPoolVolumes(withoutDust, BASE, [ASSET], NETWORK, FROM, 60, 1, resolvePoolGuards())
        expect(same[0].volume).toBe(period[0].volume)
        expect(same[0].quoteVolume).toBe(period[0].quoteVolume)
    })

    test('a higher floor from the caller drops a pool the default would count', () => {
        //the shallow pool is deliberately deeper on the quote side than the raised floor (1 000 quote against a
        //floor of 500) and shallower on the base side (200), so the raised floor drops it only because the floor
        //reads the base side. A floor measuring the quote side would keep it and this expectation would fail
        const cache = createCache([pool('deep', 5000, 10000), pool('shallow', 200, 1000)])
        const [asShipped] = getPoolVolumes(cache, BASE, [ASSET], NETWORK, FROM, 60, 1, resolvePoolGuards())
        expect(asShipped[0].volume).toBe(5200n * unit)
        const [raised] = getPoolVolumes(cache, BASE, [ASSET], NETWORK, FROM, 60, 1, resolvePoolGuards({minBaseVolume: 500}))
        expect(raised[0].volume).toBe(5000n * unit)
    })
})
