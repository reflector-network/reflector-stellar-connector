const DexTradesAggregator = require('./dex-trades-aggregator')

/**
 * @typedef {import('../rpc-connector')} RpcConnector
 * @typedef {import('@stellar/stellar-sdk').Asset} Asset
 */

/**
 * Load trades data for the specified assets and base asset
 * @param {RpcConnector} rpc - RPC server instance
 * @param {Asset} baseAsset - Base asset to aggregate trades against
 * @param {Asset[]} assets - List of assets to aggregate trades for
 * @param {number} from - Start timestamp for the aggregation period
 * @param {number} period - Length of each aggregation period in seconds
 * @param {number} limit - Number of aggregation periods to fetch
 * @return {Promise<[AssetVolumesAccumulator[]]>} - Aggregated trades data for each period
 */
async function getDexData(rpc, baseAsset, assets, from, period, limit) {
    try {
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
            const tradesForPeriod = rpc.cache.getTradesForPeriod(periodFrom, periodFrom + period)
            //accumulate trades
            tradesAggregator.processPeriodTrades(tradesForPeriod)
            //aggregate volumes
            const volumes = tradesAggregator.volumes
            //add to results
            results.push(volumes)
        }
        //clean up unneeded entries from cache
        rpc.cache.evictExpired()
        return results
    } catch (err) {
        console.error({msg: 'Error fetching dex data', err})
        return []
    }
}

module.exports = {
    getDexData
}