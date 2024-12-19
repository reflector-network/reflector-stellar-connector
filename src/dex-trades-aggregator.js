const {Asset} = require('@stellar/stellar-base')
const {xdrParseResult} = require('./meta-processor')

const MIN_VOLUME = 100n

class DexTradesAggregator {
    /**
     * @param {Asset} baseAsset
     * @param {Asset[]} assets
     */
    constructor(baseAsset, assets) {
        this.baseAsset = baseAsset
        //create asset->position mapping
        this.assets = new Map()
        for (let i = 0; i < assets.length; i++) {
            const asset = assets[i]
            if (!asset)
                continue
            this.assets.set(asset.toString(), new DexAssetTradesAccumulator(asset, i))
        }
    }

    /**
     * @type {Asset}
     * @readonly
     */
    baseAsset

    /**
     * @type {Map<String, DexAssetTradesAccumulator>}
     * @readonly
     */
    assets

    /**
     * Aggregate prices from all recorded trades and merge with previous prices
     * @param {number} expectedAssetsCount - Expected assets count (length of the output array)
     * @return {{volume: bigint, quoteVolume: bigint}[]}
     */
    aggregatePrices(expectedAssetsCount) {
        const prices = Array.from({length: expectedAssetsCount}).map(_ => ({volume: 0n, quoteVolume: 0n}))
        for (const assetAccumulator of this.assets.values()) {
            prices[assetAccumulator.index] = assetAccumulator.getData()
        }
        return prices
    }

    /**
     * Parse result XDR and process trades
     * @param {Buffer} resultXdr
     */
    processTxResult(resultXdr) {
        const res = xdrParseResult(Buffer.from(resultXdr, 'base64'))
        if (!res?.length)
            return
        for (const trade of res) {
            if (Asset.fromOperation(trade.assetSold).equals(this.baseAsset)) {
                this.processTrade(Asset.fromOperation(trade.assetBought), trade.amountSold, trade.amountBought)
            } else if (Asset.fromOperation(trade.assetBought).equals(this.baseAsset)) {
                this.processTrade(Asset.fromOperation(trade.assetSold), trade.amountBought, trade.amountSold)
            }
            //ignore trades not involving base asset (for now)
        }
    }

    /**
     * @param {Asset} asset
     * @param {BigInt} baseVolume
     * @param {BigInt} quoteVolume
     * @private
     */
    processTrade(asset, quoteVolume, baseVolume) {
        const accumulator = this.assets.get(asset.toString())
        if (!accumulator)
            return
        accumulator.processTrade(baseVolume, quoteVolume)
    }
}

class DexAssetTradesAccumulator {
    constructor(asset, index) {
        this.asset = asset
        this.index = index
        this.volume = 0n
        this.quoteVolume = 0n
    }

    /**
     * Add trade to the accumulator
     * @param {BigInt} baseVolume
     * @param {BigInt} quoteVolume
     */
    processTrade(baseVolume, quoteVolume) {
        if (baseVolume < MIN_VOLUME || quoteVolume < MIN_VOLUME)
            return
        this.volume += baseVolume
        this.quoteVolume += quoteVolume
    }

    /**
     * Aggregate price using volume-weighted price with a given precision
     * @param {BigInt} decimals
     */
    aggregate(decimals) { //TODO: move this logic to the node source code
        if (!this.volume || !this.quoteVolume)
            return 0n
        return (this.quoteVolume * (10n ** (2n * decimals))) / (this.volume * (10n ** decimals))
    }

    /**
     * @return {{volume: bigint, quoteVolume: bigint}}
     */
    getData() {
        return {volume: this.volume, quoteVolume: this.quoteVolume}
    }
}

module.exports = {DexTradesAggregator}