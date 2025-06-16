const TradesCache = require('./cache')
const DexTradesAggregator = require('./dex-trades-aggregator')

/**
 * @typedef {import('../rpc-connector')} RpcConnector
 * @typedef {import('@stellar/stellar-sdk').Asset} Asset
 */

/**
 * @type {TradesCache}
 */
let cache

/**
 * Load trades data for the specified assets and base asset
 * @param {RpcConnector} rpc - RPC server instance
 * @param {Asset[]} assets - List of assets to aggregate trades for
 * @param {Asset} baseAsset - Base asset to aggregate trades against
 * @param {number} from - Start timestamp for the aggregation period
 * @param {number} period - Length of each aggregation period in seconds
 * @param {number} limit - Number of aggregation periods to fetch
 */
async function getDexData(rpc, assets, baseAsset, from, period, limit) {
    if (!cache) {
        cache = new TradesCache(period)
    }
    //generate ledger sequence ranges to load transactions
    const ranges = await rpc.generateLedgerRanges(period, limit + 1, 3)
    //load ranges in parallel
    await Promise.all(ranges.map(range => rpc.fetchTransactions(range.from, range.to)))
    //prepare results
    const results = []
    for (let i = 0; i < limit; i++) {
        const periodFrom = from + period * i
        const tradesAggregator = new DexTradesAggregator(baseAsset, assets, periodFrom)
        //retrieve trades for current period
        const tradesForPeriod = cache.getTradesForPeriod(periodFrom, periodFrom + period)
        //accumulate trades
        tradesAggregator.processPeriodTrades(tradesForPeriod)
        //aggregate volumes
        const volumes = tradesAggregator.volumes
        //add to results
        results.push(volumes)
    }
    //clean up unneeded entries from cache
    cache.evictExpired()
    return results
}

module.exports = {
    getDexData
}