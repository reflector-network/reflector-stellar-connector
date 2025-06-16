const AssetVolumesAccumulator = require('./asset-volumes-accumulator')

/**
 * @typedef {import('@stellar/stellar-sdk').Asset} Asset
 */

class AggregatorBase {
    /**
     * @param {Asset} baseAsset - base asset to aggregate trades against
     * @param {Asset[]} assets - list of assets to aggregate trades for
     * @param {number} ts - timestamp for the aggregation
     */
    constructor(baseAsset, assets, ts) {
        if (!baseAsset || !assets || !Array.isArray(assets))
            throw new Error('Invalid base asset or assets list')
        if (ts <= 0)
            throw new Error('Invalid timestamp')
        if (this.constructor === AggregatorBase)
            throw new Error('Cannot instantiate abstract class AggregatorBase')

        this.baseAsset = baseAsset.toString()
        //create asset->position mapping
        this.assets = new Map()
        this.assetsLength = assets.length
        for (let i = 0; i < assets.length; i++) {
            const asset = assets[i]
            if (!asset)
                continue
            const assetStr = asset.toString()
            this.assets.set(assetStr, new AssetVolumesAccumulator(assetStr, i, ts))
        }
    }

    /**
     * @type {Asset}
     * @readonly
     */
    baseAsset

    /**
     * @type {Map<String, AssetVolumesAccumulator>}
     * @readonly
     */
    assets

    /**
     * @type {AssetVolumesAccumulator[]}
     */
    get volumes() {
        const volumes = Array.from({length: this.assetsLength})
        for (const assetAccumulator of this.assets.values())
            volumes[assetAccumulator.index] = assetAccumulator
        return volumes
    }

    /**
     * @param {string} assetKey - asset to add volumes for
     * @param {BigInt} baseVolume - base volume
     * @param {BigInt} quoteVolume - quote volume
     * @private
     */
    addVolumes(assetKey, baseVolume, quoteVolume) {
        const accumulator = this.assets.get(assetKey)
        if (!accumulator)
            return
        accumulator.addVolumes(baseVolume, quoteVolume)
    }
}

module.exports = AggregatorBase