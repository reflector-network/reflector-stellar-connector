const AggregatorBase = require('../aggregator-base')

class DexTradesAggregator extends AggregatorBase {

    /**
     * Process trades
     * @param {Trade[]} trades
     */
    processPeriodTrades(trades) {
        for (const trade of trades) {
            if (trade.assetSold === this.baseAsset) {
                this.addVolumes(trade.assetBought, trade.amountBought, trade.amountSold)
            } else if (trade.assetBought === this.baseAsset) {
                this.addVolumes(trade.assetSold, trade.amountSold, trade.amountBought)
            }
            //ignore trades not involving base asset (for now)
        }
    }
}

module.exports = DexTradesAggregator