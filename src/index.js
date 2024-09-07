const {Asset} = require('@stellar/stellar-base')
const DbConnector = require('./db-connector')
const {DexTradesAggregator} = require('./dex-trades-aggregator')

/**
 * Initialize StellarCore database connection
 * @param {String|{user: String, database: String, password: String, host: String, [port]: Number}} dbConnectionProperties - PostgreSQL connection string or connection properties
 */
function createDbConnection(dbConnectionProperties) {
    return new DbConnector(dbConnectionProperties)
}

/**
 * Aggregate trades and prices
 * @param {DbConnector} db - Database connector
 * @param {{type: number, code: string}} baseAsset - Base asset
 * @param {{type: number, code: string}[]} assets - Tracked assets
 * @param {Number} from - Analyzed period timestamp (Unix timestamp)
 * @param {Number} period - Timeframe length, in second
 * @param {Number} limit - Number of periods to fetch
 * @return {Promise<{volume: bigint, quoteVolume: bigint}[][]>}
 */
async function aggregateTrades({db, baseAsset, assets, from, period, limit}) {
    //convert asset format
    const aggBaseAsset = convertToStellarAsset(baseAsset)
    const aggAssets = assets.map(a => convertToStellarAsset(a))
    //fetch and aggregate data for each period
    const res = []
    for (let i = 0; i < limit; i++) {
        const lower = from + period * i
        const upper = lower + period
        const tradesAggregator = new DexTradesAggregator(aggBaseAsset, aggAssets)
        //fetch and process tx results
        await db.fetchProcessTxResults(lower, upper, r => tradesAggregator.processTxResult(r))
        //aggregate prices and merge with previously set prices
        res.push(tradesAggregator.aggregatePrices(assets.length))
    }
    return res
}

function convertToStellarAsset(asset) {
    switch (asset.type) {
        case 1: // Stellar asset
            if (!asset.code)
                throw new Error(`Asset code is required`)
            const [code, issuer] = asset.code.split(':')
            if (code === 'XLM' && !issuer)
                return Asset.native()
            else if (code && issuer)
                return new Asset(code, issuer)
        default:
            return null
    }
}


module.exports = {createDbConnection, aggregateTrades}