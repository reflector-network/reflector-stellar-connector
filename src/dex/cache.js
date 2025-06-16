const {normalizeTimestamp} = require('../utils')
const {xdrParseResult} = require('./meta-processor')

/**
 * Cache containing recent transactions, grouped by timestamp (rounded to period)
 */
class TradesCache {
    constructor(period = 60, cacheSize = 16) {
        this.size = cacheSize
        this.period = period
    }

    /**
     * @type {number}
     * @readonly
     */
    size
    /**
     * @type {number}
     * @readonly
     */
    period
    /**
     * @type {number}
     * @readonly
     */
    lastCachedLedger = 0
    /**
     * @type {Map<number, {trades: Trade[], processedTxs: Set<string>}>}
     * @private
     */
    tradesData = new Map()

    /**
     * @param {TransactionInfo} tx - transaction info object
     */
    addTx(tx) {
        //normalize timestamp
        const txTimestamp = normalizeTimestamp(tx.createdAt, this.period)

        //parse trades
        const trades = xdrParseResult(tx.resultXdr, tx.txHash)
        if (!trades?.length)
            return

        //add trades to the timestamp
        this.addTxToPeriod(tx.txHash, trades, txTimestamp)

        /*//if the createdAt is the same as normalized timestamp,
        //we need to add the tx to the previous period as well,
        //because of inclusion logic in prev version
        if (txTimestamp === tx.createdAt)
            this.addTxToTimestamp(tx.txHash, trades, txTimestamp - this.period)*/

        if (tx.ledger > this.lastCachedLedger)
            this.lastCachedLedger = tx.ledger
    }

    /**
     * @param {string} txHash
     * @param {Trade[]} trades
     * @param {number} timestamp
     * @private
     */
    addTxToPeriod(txHash, trades, timestamp) {
        if (!this.tradesData.get(timestamp)) //add only if not exists
            this.tradesData.set(timestamp, {trades: [], processedTxs: new Set()})

        const tsTrades = this.tradesData.get(timestamp)
        if (tsTrades.processedTxs.has(txHash)) //already processed
            return

        tsTrades.processedTxs.add(txHash)
        tsTrades.trades.push(...trades)
    }

    /**
     * @param {number} from
     * @param {number} to
     * @return {Trade[]}
     */
    getTradesForPeriod(from, to) {
        const trades = []
        for (let ts = from; ts < to; ts += this.period) {
            const periodTrades = this.tradesData.get(ts)
            if (periodTrades)
                trades.push(...periodTrades.trades)
        }
        return trades
    }

    /**
     * Remove expired periods from cache
     */
    evictExpired() {
        const removeCount = this.tradesData.size - this.size
        if (removeCount <= 0)
            return
        const timestamps = Array.from(this.tradesData.keys())
        timestamps.sort()
        const keysToRemove = timestamps.slice(0, removeCount)
        for (const key of keysToRemove) {
            this.tradesData.delete(key)
        }
    }
}

module.exports = TradesCache