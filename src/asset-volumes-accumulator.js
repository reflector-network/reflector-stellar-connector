const {adjustPrecision} = require('./utils')

const MIN_VOLUME = adjustPrecision(100n, 7)

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
     * @param {BigInt} baseVolume
     * @param {BigInt} quoteVolume
     */
    addVolumes(baseVolume, quoteVolume) {
        if (!baseVolume || !quoteVolume || baseVolume < MIN_VOLUME || quoteVolume < MIN_VOLUME)
            return
        this.volume += baseVolume
        this.quoteVolume += quoteVolume
    }
}

module.exports = AssetVolumesAccumulator