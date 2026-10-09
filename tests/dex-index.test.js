/*eslint-disable no-undef */
const {getDexVolumes} = require('../src/dex')

console.debug = jest.fn()
console.info = jest.fn()
console.warn = jest.fn()
console.error = jest.fn()
console.log = jest.fn()

const NETWORK = 'Public Global Stellar Network ; September 2015'
const BASE = 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
const ASSET = 'AQUA:GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA'

function createCache(hasPoolData) {
    return {
        period: 60,
        hasPoolDataForPeriod: jest.fn(() => hasPoolData),
        isPairValidForPeriod: jest.fn(() => true),
        getTradesForPeriod: jest.fn(() => [{
            assetSold: BASE,
            assetBought: ASSET,
            amountSold: 500000000000000n,
            amountBought: 1000000000000000n,
            txHash: 'tx1'
        }])
    }
}

describe('getDexVolumes needs the period pool snapshot', () => {
    beforeEach(() => jest.clearAllMocks())

    test('a period without a pool snapshot reports no DEX volume', () => {
        const cache = createCache(false)
        const [period] = getDexVolumes(cache, BASE, [ASSET], NETWORK, 1780009200, 60, 1)
        expect(period[0]).toBeUndefined()
        expect(cache.getTradesForPeriod).not.toHaveBeenCalled()
        expect(console.warn).toHaveBeenCalledWith(expect.objectContaining({msg: 'No pool snapshot for period - DEX trades not counted'}))
    })

    test('a period with a pool snapshot counts its trades, without the warning', () => {
        const cache = createCache(true)
        const [period] = getDexVolumes(cache, BASE, [ASSET], NETWORK, 1780009200, 60, 1)
        expect(period[0].volume).toBe(500000000000000n)
        expect(period[0].quoteVolume).toBe(1000000000000000n)
        expect(console.warn).not.toHaveBeenCalled()
    })

    test('an asset whose pools discovery did not try for the period counts no trades', () => {
        const cache = createCache(true)
        cache.isPairValidForPeriod = jest.fn(() => false)
        const [period] = getDexVolumes(cache, BASE, [ASSET], NETWORK, 1780009200, 60, 1)
        expect(period[0]).toBeUndefined()
        expect(cache.isPairValidForPeriod).toHaveBeenCalledWith(1780009200, 1780009260, BASE, ASSET)
    })

    test('on the cross path each pair is checked against the cross asset, the base asset included', () => {
        const cache = createCache(true)
        getDexVolumes(cache, 'XLM', [BASE, ASSET], NETWORK, 1780009200, 60, 1)
        expect(cache.isPairValidForPeriod).toHaveBeenCalledWith(1780009200, 1780009260, 'XLM', BASE)
        expect(cache.isPairValidForPeriod).toHaveBeenCalledWith(1780009200, 1780009260, 'XLM', ASSET)
    })
})
