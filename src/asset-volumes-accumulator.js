const {getVWAP} = require('./utils')

const MIN_VOLUME = 100n

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

    getPrice() {
        return getVWAP(this.volume, this.quoteVolume)
    }
}

module.exports = AssetVolumesAccumulator