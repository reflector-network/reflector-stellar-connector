const RpcConnector = require('./rpc-connector')
const {DexTradesAggregator} = require('./dex-trades-aggregator')
const {convertToStellarAsset} = require('./asset-encoder')
const cache = require('./cache')

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
    const rpc = new RpcConnector(rpcUrl)
    //convert asset format
    const aggBaseAsset = convertToStellarAsset(baseAsset)
    const aggAssets = assets.map(a => convertToStellarAsset(a))

    const batches = await rpc.getBatchInfos(period, limit)
    await Promise.all(batches.map((batchInfo) => rpc.fetchTransactions(batchInfo.from, batchInfo.to)))

    let results = []
    for (let i = 0; i < limit; i++) {
        const periodFrom = from + period * i
        const periodTo = periodFrom + period
        const tradesAggregator = new DexTradesAggregator(aggBaseAsset, aggAssets)
        const tradesForPeriod = cache.getTradesForPeriod(periodFrom, periodTo)
        console.log(`${periodTo}: ${tradesForPeriod.length}`)
        tradesAggregator.processTradeInfos(tradesForPeriod)
        const volumes = tradesAggregator.aggregatePrices(assets.length)
        //add timestamps
        volumes.forEach(v => v.ts = periodTo)
        results.push(volumes)
    }
    cache.clearOldTrades()
    console.log('Last ledger:', cache.lastCachedLedger)
    return results
}

module.exports = {aggregateTrades}