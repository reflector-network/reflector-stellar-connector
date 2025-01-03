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

    const batches = await rpc.getBatchInfos(period, limit + 1)

    await Promise.all(batches.map((batchInfo) => rpc.fetchTransactions(batchInfo.from, batchInfo.to)))

    let results = []
    for (let i = 0; i < limit; i++) {
        const periodFrom = from + period * i
        const tradesAggregator = new DexTradesAggregator(aggBaseAsset, aggAssets)
        const tradesForPeriod = cache.getTradesForPeriod(periodFrom, periodFrom + period)
        tradesAggregator.processTradeInfos(tradesForPeriod)
        const volumes = tradesAggregator.aggregatePrices(assets.length)
        //add timestamps
        volumes.forEach(v => v.ts = periodFrom)
        results.push(volumes)
    }
    cache.evictExpired()
    return results
}

module.exports = {aggregateTrades, trimTimestampTo}