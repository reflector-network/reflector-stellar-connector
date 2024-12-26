const { xdrParseResult } = require('./meta-processor')


// last cached txs, grouped by timestamp (rounded to PERIOD)
class TradesCache {
    constructor() {
        this.setLimit(15)
    }

    /**
     * @type {Map<number, {trades: Trade[], processedTxs: Set<string>}>}
     */
    tradesData = new Map()

    /**
     * @type {number}
     */
    lastCachedLedger = 0

    setLimit(limit) {
        this.limit = limit
    }

    /**
     * @param {any} tx
     */
    addTx(tx) {
        //normalize timestamp
        const txTimestamp = Math.floor(tx.createdAt / TradesCache.PERIOD) * TradesCache.PERIOD

        //parse trades
        const trades = xdrParseResult(tx.resultXdr, tx.txHash)
        if (!trades?.length)
            return

        //add trades to the timestamp
        this.addTxToTimestamp(tx.txHash, trades, txTimestamp)

        //if the createdAt is the same as normalized timestamp, 
        //we need to add the tx to the previous period as well, 
        //because of inclusion logic in prev version
        if (txTimestamp === tx.createdAt) 
            this.addTxToTimestamp(tx.txHash, trades, txTimestamp - TradesCache.PERIOD)

        if (tx.ledger > this.lastCachedLedger)
            this.lastCachedLedger = tx.ledger
    }

    addTxToTimestamp(txHash, trades, timestamp) {
        if (!this.tradesData.get(timestamp)) //add only if not exists
            this.tradesData.set(timestamp, {trades: [], processedTxs: new Set()})

        const tsTrades = this.tradesData.get(timestamp)
        if (tsTrades.processedTxs.has(txHash)) //already processed
            return
        
        tsTrades.processedTxs.add(txHash)
        tsTrades.trades.push(...trades)
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