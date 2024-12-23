const RpcConnector = require('./rpc-connector')
const {DexTradesAggregator} = require('./dex-trades-aggregator')
const {convertToStellarAsset} = require('./asset-encoder')

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
    //fetch and aggregate data for each period
    return await Promise.all((new Array(limit).fill(0)).map((_, i) => {
        const periodFrom = from + period * i
        const periodTo = periodFrom + period
        const tradesAggregator = new DexTradesAggregator(aggBaseAsset, aggAssets)
        //fetch and process tx results
        return rpc.fetchTransactions(periodFrom, periodTo, r => tradesAggregator.processTx(r))
            //aggregate and merge with previously set prices
            .then(() => tradesAggregator.aggregatePrices(assets.length))
    }))
}

module.exports = {aggregateTrades}