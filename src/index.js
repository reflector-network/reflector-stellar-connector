const db = require('./db-connector')
const {parseStateData, encodeContractId} = require('./contract-state-parser')
const {DexTradesAggregator} = require('./dex-trades-aggregator')

/**
 * Initialize StellarCore database connection
 * @param {String|{user: String, database: String, password: String, host: String, [port]: Number}} dbConnectionProperties
 */
function init(dbConnectionProperties) {
    db.init(dbConnectionProperties)
}

/**
 * Aggregate trades and prices
 * @param {String} contract - Contract Id
 * @param {Asset} baseAsset - Base asset
 * @param {Asset[]} assets - Tracked assets
 * @param {Number} decimals - Price precision
 * @param {Number} from - Analyzed period timestamp (Unix timestamp)
 * @param {Number} period - Timeframe length, in second
 * @return {Promise<{admin: {address: String, sequence: BigInt, thresholds: Number[], signers: {address: String, weight: Number}[]}, prices: BigInt[]}>}
 */
async function aggregateTrades({contract, baseAsset, assets, decimals, from, period}) {
    const tradesAggregator = new DexTradesAggregator(baseAsset, assets)
    const contractData = await db.fetchContractState(encodeContractId(contract))
    //retrieve previous prices from contract state
    const parsedContractState = parseStateData(contractData)
    //fetch and process tx results
    await db.fetchProcessTxResults(from, from + period, r => tradesAggregator.processTxResult(r))
    //aggregate prices and merge with previously set prices
    const prices = tradesAggregator.aggregatePrices(parsedContractState.prices, BigInt(decimals))
    //retrieve current state of admin account
    const adminProps = await db.fetchAccountProps(parsedContractState.admin)
    return {
        prices,
        admin: {
            address: parsedContractState.admin,
            sequence: adminProps.sequence,
            signers: adminProps.signers,
            thresholds: adminProps.thresholds
        }
    }
}

module.exports = {init, aggregateTrades}