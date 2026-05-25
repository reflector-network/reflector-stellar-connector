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
 * @param {string} network - Network passphrase
 * @param {number} from - Start timestamp for the aggregation period
 * @param {number} period - Length of each aggregation period in seconds
 * @param {number} limit - Number of aggregation periods to fetch
 * @return {{volumes: BigInt, quoteVolume: BigInt}[]} - Aggregated trades data for each period
 */
function getDexVolumes(cache, baseAsset, assets, network, from, period, limit) {
    //prepare results
    const results = []
    for (let i = 0; i < limit; i++) {
        const periodFrom = from + period * i
        const periodTo = periodFrom + period
        const tradesAggregator = new DexTradesAggregator(baseAsset, assets, network, periodFrom)
        //skip DEX for periods where pool reserves were never loaded
        if (cache.hasPoolDataForPeriod(periodFrom, periodTo)) {
            //retrieve trades for current period
            const tradesForPeriod = cache.getTradesForPeriod(periodFrom, periodTo)
            //accumulate trades
            tradesAggregator.processPeriodTrades(tradesForPeriod)
        } else {
            console.debug({msg: 'Skipping DEX trades — no pool data for period', from: periodFrom, to: periodTo})
        }
        //aggregate volumes
        const volumes = tradesAggregator.volumes
        //add to results
        results.push(volumes)
    }
    return results
}

module.exports = {
    getDexVolumes
}