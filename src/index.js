const db = require('./db-connector')
const {parseStateData, encodeContractId, parseAccountSigners} = require('./contract-state-parser')
const {DexTradesAggregator} = require('./dex-trades-aggregator')
const {Asset} = require('stellar-base')

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
 * @param {{type: number, code: string}} baseAsset - Base asset
 * @param {{type: number, code: string}[]} assets - Tracked assets
 * @param {Number} decimals - Price precision
 * @param {Number} from - Analyzed period timestamp (Unix timestamp)
 * @param {Number} period - Timeframe length, in second
 * @return {Promise<{prices: BigInt[], admin: String, lastTimestamp: BigInt}>}
 */
async function aggregateTrades({contract, baseAsset, assets, decimals, from, period}) {
    const tradesAggregator = new DexTradesAggregator(convertToStellarAsset(baseAsset), assets.map(a => convertToStellarAsset(a)))
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

function convertToStellarAsset(asset) {
    switch (asset.type) {
        case 1: // Stellar asset
            if (!asset.code)
                throw new Error(`Asset code is required`)
            const [code, issuer] = asset.code.split(':')
            if (code === 'XLM' && !issuer)
                return Asset.native()
            else if (issuer)
                return new Asset(code, issuer)
            else
                throw new Error(`Unsupported asset: ${asset.code}`)
        default:
            throw new Error(`Unsupported asset type: ${asset.type}`)
    }
}

module.exports = {init, aggregateTrades, retrieveAccountProps}