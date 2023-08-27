const db = require('./db-connector')
const {parseStateData, encodeContractId} = require('./contract-state-parser')
const {DexTradesAggregator} = require('./dex-trades-aggregator')

/**
 * Initialize StellarCore database connection
 * @param {String} dbConnectionString
 */
function init(dbConnectionString) {
    db.init(dbConnectionString)
}

/**
 * Aggregate trades and prices
 * @param {String} contract - Contract Id
 * @param {Asset} baseAsset - Base asset
 * @param {Asset[]} assets - Tracked assets
 * @param {Number} protocolVersion - Contract protocol version
 * @param {Number} decimals - Price precision
 * @param {Number} from - Analyzed period timestamp (Unix timestamp)
 * @param {Number} period - Timeframe length, in second
 * @return {Promise<BigInt[]>}
 */
async function aggregateTrades({contract, baseAsset, assets, protocolVersion, decimals, from, period}) {
    const tradesAggregator = new DexTradesAggregator(baseAsset, assets)
    const contractData = await db.fetchContractState(encodeContractId(contract))
    //retrieve previous prices from contract state
    const prevPrices = parseStateData(contractData, protocolVersion)
    //fetch and process tx results
    await db.fetchProcessTxResults(from, from + period, r => tradesAggregator.processTxResult(r))
    //aggregate prices and merge with previously set prices
    return tradesAggregator.aggregatePrices(prevPrices.prices, BigInt(decimals))
}

module.exports = {init, aggregateTrades}