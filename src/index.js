const DbConnector = require('./db-connector')
const {DexTradesAggregator} = require('./dex-trades-aggregator')
const {parseStateData, encodeContractId, parseAccountSigners} = require('./contract-state-parser')

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
 * @param {Asset} baseAsset - Base asset
 * @param {Asset[]} assets - Tracked assets
 * @param {Number} decimals - Price precision
 * @param {Number} from - Analyzed period timestamp (Unix timestamp)
 * @param {Number} period - Timeframe length, in second
 * @param {BigInt[]} prevPrices - Prices array from the previous round
 * @return {Promise<BigInt[]>}
 */
async function aggregateTrades({db, baseAsset, assets, decimals, from, period, prevPrices}) {
    const tradesAggregator = new DexTradesAggregator(baseAsset, assets)
    //fetch and process tx results
    await db.fetchProcessTxResults(from, from + period, r => tradesAggregator.processTxResult(r))
    //aggregate prices and merge with previously set prices
    return tradesAggregator.aggregatePrices(prevPrices, BigInt(decimals))
}

/**
 * Retrieve current contract state data
 * @param {DbConnector} db - Database connector
 * @param {String} contract - Contract ID in StrKey encoding
 * @return {Promise<{admin: String, lastTimestamp: BigInt, prices: BigInt[]}>}
 */
async function retrieveContractState(db, contract){
    const contractData = await db.fetchContractState(encodeContractId(contract))
    //parse relevant data from the contract state
    return parseStateData(contractData)
}

/**
 * Fetch account properties from the database
 * @param {DbConnector} db - Database connector
 * @param {String} account - Account address
 * @return {Promise<{sequence: BigInt, thresholds: Number[], signers: {address: String, weight: Number}[]}>}
 */
async function retrieveAccountProps(db, account) {
    const accountProps = await db.fetchAccountProps(account)
    if (accountProps.signers) {
        accountProps.signers = parseAccountSigners(accountProps.signers)
    }
    return accountProps
}

module.exports = {createDbConnection, aggregateTrades, retrieveContractState, retrieveAccountProps}