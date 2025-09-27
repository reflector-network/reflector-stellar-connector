const DexTradesAggregator = require('./dex-trades-aggregator')

/**
 * @typedef {import('../cache')} TxCache
 * @typedef {import('@stellar/stellar-sdk').Asset} Asset
 * @typedef {import('../asset-volumes-accumulator')} AssetVolumesAccumulator
 */

/**
 * Load trades data for the specified assets and base asset
 * @param {TxCache} cache - Cache instance to store transactions
 * @param {Asset} baseAsset - Base asset to aggregate trades against
 * @param {Asset[]} assets - List of assets to aggregate trades for
 * @param {number} from - Start timestamp for the aggregation period
 * @param {number} period - Length of each aggregation period in seconds
 * @param {number} limit - Number of aggregation periods to fetch
 * @return {[AssetVolumesAccumulator[]]} - Aggregated trades data for each period
 */
function getDexData(cache, baseAsset, assets, from, period, limit) {
    try {
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
        return results
    } catch (err) {
        console.error({msg: 'Error fetching dex data', err})
        return []
    }
}

module.exports = {
    getDexData
}