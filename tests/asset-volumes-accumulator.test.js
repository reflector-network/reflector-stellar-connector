/*eslint-disable no-undef */
const AssetVolumesAccumulator = require('../src/asset-volumes-accumulator')
const {getVWAP, adjustPrecision} = require('../src/utils')

//100 raw stroops, rescaled to TARGET_DECIMALS=14
const MIN_VOLUME = adjustPrecision(100n, 7) //= 10^9

describe('AssetVolumesAccumulator', () => {
    it('should initialize with zero volumes', () => {
        const acc = new AssetVolumesAccumulator('XLM', 0, 1000)
        expect(acc.asset).toBe('XLM')
        expect(acc.index).toBe(0)
        expect(acc.volume).toBe(0n)
        expect(acc.quoteVolume).toBe(0n)
        expect(acc.ts).toBe(1000)
    })

    it('should accumulate volumes', () => {
        const acc = new AssetVolumesAccumulator('XLM', 0, 1000)
        acc.addVolumes(5n * MIN_VOLUME, 10n * MIN_VOLUME)
        acc.addVolumes(3n * MIN_VOLUME, 6n * MIN_VOLUME)
        expect(acc.volume).toBe(8n * MIN_VOLUME)
        expect(acc.quoteVolume).toBe(16n * MIN_VOLUME)
    })

    it('should reject volumes below MIN_VOLUME', () => {
        const acc = new AssetVolumesAccumulator('XLM', 0, 1000)
        acc.addVolumes(MIN_VOLUME / 2n, 2n * MIN_VOLUME) //baseVolume < MIN_VOLUME
        expect(acc.volume).toBe(0n)

        acc.addVolumes(2n * MIN_VOLUME, MIN_VOLUME / 2n) //quoteVolume < MIN_VOLUME
        expect(acc.volume).toBe(0n)

        acc.addVolumes(MIN_VOLUME - 1n, MIN_VOLUME - 1n) //both just below
        expect(acc.volume).toBe(0n)
    })

    it('should accept volumes at exactly MIN_VOLUME', () => {
        const acc = new AssetVolumesAccumulator('XLM', 0, 1000)
        acc.addVolumes(MIN_VOLUME, MIN_VOLUME)
        expect(acc.volume).toBe(MIN_VOLUME)
        expect(acc.quoteVolume).toBe(MIN_VOLUME)
    })

    it('should ignore zero or falsy volumes', () => {
        const acc = new AssetVolumesAccumulator('XLM', 0, 1000)
        acc.addVolumes(0n, 10n * MIN_VOLUME)
        acc.addVolumes(10n * MIN_VOLUME, 0n)
        acc.addVolumes(undefined, 10n * MIN_VOLUME)
        acc.addVolumes(10n * MIN_VOLUME, undefined)
        expect(acc.volume).toBe(0n)
        expect(acc.quoteVolume).toBe(0n)
    })

    it('should compute VWAP price via getPrice()', () => {
        const acc = new AssetVolumesAccumulator('XLM', 0, 1000)
        acc.addVolumes(10n * MIN_VOLUME, 20n * MIN_VOLUME)
        acc.addVolumes(30n * MIN_VOLUME, 40n * MIN_VOLUME)
        //volume=40·MIN_VOLUME, quoteVolume=60·MIN_VOLUME → VWAP = 40/60 scaled to 14 decimals
        expect(getVWAP(acc.volume, acc.quoteVolume)).toBe(66666666666666n)
    })

    it('should return 0n price when no volumes added', () => {
        const acc = new AssetVolumesAccumulator('XLM', 0, 1000)
        expect(getVWAP(acc.volume, acc.quoteVolume)).toBe(0n)
    })
})
