const { xdrParseResult } = require('./meta-processor')


// last cached txs, grouped by timestamp (rounded to PERIOD)
class TradesCache {
    constructor() {
        this.setLimit(15)
        this.tradesData = new Map()
        this.lastCachedLedger = 0
    }

    setLimit(limit) {
        this.limit = limit
    }

    /**
     * @param {any} tx
     */
    addTx(tx) {
        //normalize timestamp
        const txTimestamp = Math.floor(tx.createdAt / TradesCache.PERIOD) * TradesCache.PERIOD
        if (!this.tradesData.get(txTimestamp)) //add only if not exists
            this.tradesData.set(txTimestamp, {trades: [], processedTxs: new Set()})

        const tsTrades = this.tradesData.get(txTimestamp)
        if (tsTrades.processedTxs.has(tx.txHash)) //already processed
            return
        
        const result = xdrParseResult(tx.resultXdr, tx.txHash)
        for (const trade of result)
            tsTrades.trades.push(trade)

        if (tx.ledger > this.lastCachedLedger)
            this.lastCachedLedger = tx.ledger
    }

    getTradesForPeriod(from, to) {
        const trades = []
        for (let ts = from; ts <= to; ts += this.period) {
            const tsTrades = this.tradesData.get(ts)
            if (tsTrades)
                trades.push(...tsTrades.trades)
        }
        return trades
    }

    getLastLedger() {
        return this.lastCachedLedger
    }

    clearOldTrades() {
        while (this.tradesData.size > this.limit + 1) { //remove oldest trades
            const oldestTimestamp = Math.min(...this.tradesData.keys())
            this.tradesData.delete(oldestTimestamp)
        }
    }

    // 1 minute
    static PERIOD = 60
}

module.exports = new TradesCache()