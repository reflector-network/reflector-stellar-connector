/*eslint-disable no-undef */
const AssetVolumesAccumulator = require('../src/asset-volumes-accumulator')
const {getVWAP} = require('../src/utils')

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
        acc.addVolumes(500n, 1000n)
        acc.addVolumes(300n, 600n)
        expect(acc.volume).toBe(800n)
        expect(acc.quoteVolume).toBe(1600n)
    })

    it('should reject volumes below MIN_VOLUME (100n)', () => {
        const acc = new AssetVolumesAccumulator('XLM', 0, 1000)
        acc.addVolumes(50n, 200n) //baseVolume < 100
        expect(acc.volume).toBe(0n)

        acc.addVolumes(200n, 50n) //quoteVolume < 100
        expect(acc.volume).toBe(0n)

        acc.addVolumes(99n, 99n) //both below
        expect(acc.volume).toBe(0n)
    })

    it('should accept volumes at exactly MIN_VOLUME', () => {
        const acc = new AssetVolumesAccumulator('XLM', 0, 1000)
        acc.addVolumes(100n, 100n)
        expect(acc.volume).toBe(100n)
        expect(acc.quoteVolume).toBe(100n)
    })

    it('should ignore zero or falsy volumes', () => {
        const acc = new AssetVolumesAccumulator('XLM', 0, 1000)
        acc.addVolumes(0n, 1000n)
        acc.addVolumes(1000n, 0n)
        acc.addVolumes(undefined, 1000n)
        acc.addVolumes(1000n, undefined)
        expect(acc.volume).toBe(0n)
        expect(acc.quoteVolume).toBe(0n)
    })

    it('should compute VWAP price via getPrice()', () => {
        const acc = new AssetVolumesAccumulator('XLM', 0, 1000)
        acc.addVolumes(1000n, 2000n)
        acc.addVolumes(3000n, 4000n)
        expect(getVWAP(acc.volume, acc.quoteVolume)).toBe(66666666666666n)
    })

    it('should return 0n price when no volumes added', () => {
        const acc = new AssetVolumesAccumulator('XLM', 0, 1000)
        expect(getVWAP(acc.volume, acc.quoteVolume)).toBe(0n)
    })
})
