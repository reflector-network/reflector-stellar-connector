const RpcConnector = require('./rpc-connector')
const {DexTradesAggregator} = require('./dex-trades-aggregator')
const {convertToStellarAsset} = require('./asset-encoder')
const {trimTimestampTo} = require('./time-util')
const TradesCache = require('./cache')

let cache

/**
 * Aggregate trades and prices
 * @param {string} rpcUrl - URL of the RPC server with enabled `getTransactions` and `getLedgers` endpoints
 * @param {{type: number, code: string}} baseAsset - Base asset
 * @param {{type: number, code: string}[]} assets - Tracked assets
 * @param {number} from - Analyzed period timestamp (Unix timestamp)
 * @param {number} period - Timeframe length, in second
 * @param {number} limit - Number of periods to fetch
 * @return {Promise<{volume: bigint, quoteVolume: bigint}[][]>}
 */
async function aggregateTrades({rpcUrl, baseAsset, assets, from, period, limit}) {
    if (!cache) {
        cache = new TradesCache(period)
    }
    const rpc = new RpcConnector(rpcUrl, cache)
    //convert asset format
    const aggBaseAsset = convertToStellarAsset(baseAsset)
    const aggAssets = assets.map(a => convertToStellarAsset(a))
    //generate ledger sequence ranges to load transactions
    const ranges = await rpc.generateLedgerRanges(period, limit + 1, 3)
    //load ranges in parallel
    await Promise.all(ranges.map(range => rpc.fetchTransactions(range.from, range.to)))
    //prepare results
    let results = []
    for (let i = 0; i < limit; i++) {
        const periodFrom = from + period * i
        const tradesAggregator = new DexTradesAggregator(aggBaseAsset, aggAssets)
        //retrieve trades for current period
        const tradesForPeriod = cache.getTradesForPeriod(periodFrom, periodFrom + period)
        //accumulate trades
        tradesAggregator.processPeriodTrades(tradesForPeriod)
        //aggregate volumes
        const volumes = tradesAggregator.aggregatePrices(assets.length, periodFrom)
        //add to results
        results.push(volumes)
    }
    //clean up unneeded entries from cache
    cache.evictExpired()
    return results
}

module.exports = {aggregateTrades, trimTimestampTo}