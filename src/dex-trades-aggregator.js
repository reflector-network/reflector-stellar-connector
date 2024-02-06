const {Asset} = require('@stellar/stellar-base')
const {xdrParseResult} = require('./meta-processor')

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
     * @param {BigInt[]} prevPrices
     * @param {BigInt} decimals
     * @return {BigInt[]}
     */
    aggregatePrices(prevPrices, decimals) {
        const prices = new Array(prevPrices.length)
        for (const assetAccumulator of this.assets.values()) {
            prices[assetAccumulator.index] = assetAccumulator.aggregate(decimals) || prevPrices[assetAccumulator.index] || 0n
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
        this.baseVolume = 0n
        this.quoteVolume = 0n
    }

    /**
     * Add trade to the accumulator
     * @param {BigInt} baseVolume
     * @param {BigInt} quoteVolume
     */
    processTrade(baseVolume, quoteVolume) {
        this.baseVolume += baseVolume
        this.quoteVolume += quoteVolume
    }

    /**
     * Aggregate price using volume-weighted price with a given precision
     * @param {BigInt} decimals
     */
    aggregate(decimals) {
        if (!this.baseVolume || !this.quoteVolume)
            return 0n
        return (this.quoteVolume * (10n ** (2n * decimals))) / (this.baseVolume * (10n ** decimals))
    }
}

module.exports = {DexTradesAggregator}