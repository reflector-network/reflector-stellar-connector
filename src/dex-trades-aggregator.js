const {Asset} = require('@stellar/stellar-sdk')
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
     * @param {number} ts - Period timestamp
     * @return {{volume: bigint, quoteVolume: bigint, ts: number}[]}
     */
    aggregatePrices(expectedAssetsCount, ts) {
        const prices = Array.from({length: expectedAssetsCount}).map(_ => ({volume: 0n, quoteVolume: 0n, ts}))
        for (const assetAccumulator of this.assets.values()) {
            const data = assetAccumulator.getData()
            data.ts = ts
            prices[assetAccumulator.index] = data
        }
        return prices
    }

    /**
     * Process trades
     * @param {Trade[]} trades
     */
    processPeriodTrades(trades) {
        for (const trade of trades) {
            if (trade.assetSold.equals(this.baseAsset)) {
                this.processTrade(trade.assetBought, trade.amountSold, trade.amountBought)
            } else if (trade.assetBought.equals(this.baseAsset)) {
                this.processTrade(trade.assetSold, trade.amountBought, trade.amountSold)
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
     * @return {{volume: bigint, quoteVolume: bigint}}
     */
    getData() {
        return {volume: this.volume, quoteVolume: this.quoteVolume}
    }
}

module.exports = {DexTradesAggregator}