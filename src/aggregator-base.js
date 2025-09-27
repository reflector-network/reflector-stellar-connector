const AssetVolumesAccumulator = require('./asset-volumes-accumulator')
const {encodeAssetContractId} = require('./utils')

/**
 * @typedef {import('@stellar/stellar-sdk').Asset} Asset
 */

class AggregatorBase {
    /**
     * @param {Asset} baseAsset - base asset to aggregate trades against
     * @param {Asset[]} assets - list of assets to aggregate trades for
     * @param {string} network - network passphrase
     * @param {number} ts - timestamp for the aggregation
     */
    constructor(baseAsset, assets, network, ts) {
        if (!baseAsset || !assets || !Array.isArray(assets))
            throw new Error('Invalid base asset or assets list')
        if (ts <= 0)
            throw new Error('Invalid timestamp')
        if (this.constructor === AggregatorBase)
            throw new Error('Cannot instantiate abstract class AggregatorBase')

        this.baseAsset = baseAsset.toString()
        this.baseToken = encodeAssetContractId(baseAsset, network)
        this.tokens = new Map()
        //create asset->position mapping
        this.assets = new Map()
        this.assetsLength = assets.length
        for (let i = 0; i < assets.length; i++) {
            const asset = assets[i]
            if (!asset)
                continue
            const assetStr = asset.toString()
            this.assets.set(assetStr, new AssetVolumesAccumulator(assetStr, i, ts))
            this.tokens.set(encodeAssetContractId(asset, network), assetStr)
        }
    }

    /**
     * @type {string}
     * @readonly
     */
    baseToken

    /**
     * @type {string}
     * @readonly
     */
    baseAsset

    /**
     * Map of token contract IDs to asset strings
     * @type {Map<string, string>}
     * @readonly
     */
    tokens

    /**
     * @type {Map<string, AssetVolumesAccumulator>}
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
     * @param {string} asset - asset to add volumes for
     * @param {BigInt} baseVolume - base volume
     * @param {BigInt} quoteVolume - quote volume
     * @private
     */
    addVolumes(asset, baseVolume, quoteVolume) {
        const accumulator = this.assets.get(asset)
        if (!accumulator)
            return
        accumulator.addVolumes(baseVolume, quoteVolume)
    }
}

module.exports = AggregatorBase