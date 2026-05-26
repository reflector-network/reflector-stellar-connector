const {adjustPrecision} = require('./utils')

const MIN_VOLUME = adjustPrecision(100n, 7)

/**
 * Accumulates per-asset volumes against the pricing baseAsset.
 * `volume` sums the baseAsset side, `quoteVolume` sums the target asset side,
 * so getVWAP(volume, quoteVolume) yields baseAsset per target.
 */
class AssetVolumesAccumulator {
    constructor(asset, index, ts) {
        this.asset = asset
        this.index = index
        this.volume = 0n
        this.quoteVolume = 0n
        this.ts = ts
    }

    /**
     * Add volumes
     * @param {BigInt} baseVolume - baseAsset side
     * @param {BigInt} quoteVolume - target asset side
     */
    addVolumes(baseVolume, quoteVolume) {
        if (!baseVolume || !quoteVolume || baseVolume < MIN_VOLUME || quoteVolume < MIN_VOLUME)
            return
        this.volume += baseVolume
        this.quoteVolume += quoteVolume
    }
}

module.exports = AssetVolumesAccumulator