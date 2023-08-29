const db = require('./db-connector')
const {parseStateData, encodeContractId, parseAccountSigners} = require('./contract-state-parser')
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
 * @return {Promise<{prices: BigInt[], admin: String, lastTimestamp: BigInt}>}
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
    return {
        prices,
        admin: parsedContractState.admin,
        lastTimestamp: parsedContractState.lastTimestamp
    }
}

/**
 * Fetch account properties from the database
 * @param {String} account - Account address
 * @return {Promise<{sequence: BigInt, thresholds: Number[], signers: {address: String, weight: Number}[]}>}
 */
async function retrieveAccountProps(account) {
    const accountProps = await db.fetchAccountProps(account)
    if (accountProps.signers) {
        accountProps.signers = parseAccountSigners(accountProps.signers)
    }
    return accountProps
}

module.exports = {init, aggregateTrades, retrieveAccountProps}