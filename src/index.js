const DbConnector = require('./db-connector')
const {DexTradesAggregator} = require('./dex-trades-aggregator')
const {parseStateData, encodeContractId, parseAccountSigners} = require('./contract-state-parser')
const {Asset} = require('stellar-base')

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
 * @param {Number} decimals - Price precision
 * @param {Number} from - Analyzed period timestamp (Unix timestamp)
 * @param {Number} period - Timeframe length, in second
 * @param {BigInt[]} prevPrices - Prices array from the previous round
 * @return {Promise<BigInt[]>}
 */
async function aggregateTrades({db, baseAsset, assets, decimals, from, period, prevPrices}) {
    const tradesAggregator = new DexTradesAggregator(convertToStellarAsset(baseAsset), assets.map(a => convertToStellarAsset(a)))
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
            else
                throw new Error(`Unsupported asset: ${asset.code}`)
        default:
            throw new Error(`Unsupported asset type: ${asset.type}`)
    }
}


module.exports = {createDbConnection, aggregateTrades, retrieveContractState, retrieveAccountProps}