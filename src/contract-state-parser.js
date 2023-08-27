const {StrKey, xdr, scValToBigInt} = require('stellar-base')

/**
 * Retrieve and parse contract state data
 * @param {ContractStateRawData} contractData - Contract data state retrieved from StellarCore db
 * @param {Number} expectedProtocolVersion - Current node protocol version
 * @return {{lastTimestamp: BigInt, prices:BigInt[]}}
 */
function parseStateData(contractData, expectedProtocolVersion) {
    const protocolVersion = parseStateLedgerEntry(contractData.version).body().data().val().u32()
    if (protocolVersion > expectedProtocolVersion)
        throw new Error(`Unsupported protocol version. Current node protocol version: ${expectedProtocolVersion}, quorum protocol version: ${protocolVersion}.`)

    const prices = []
    let total = 0
    for (const p of contractData.prices) {
        const contractData = parseStateLedgerEntry(p)
        const index = contractData.key().u128().lo().low
        prices[index] = scValToBigInt(contractData.body().data().val())
        total++
    }
    if (prices.length !== total)
        throw new Error(`Missing price data for ${prices.length - total} assets.`)
    return {
        lastTimestamp: typeof contractData.lastTimestamp === 'string' ? scValToBigInt(parseStateLedgerEntry(contractData.lastTimestamp).body().data().val()) : contractData.lastTimestamp,
        prices
    }
}

/**
 * @param {String} contractId
 * @return {String}
 */
function encodeContractId(contractId) {
    return xdr.ScAddress.scAddressTypeContract(StrKey.decodeContract(contractId)).toXDR('base64')
}

/**
 * @param {String} value
 * @return {xdr.ContractDataEntry}
 * @private
 */
function parseStateLedgerEntry(value) {
    return xdr.LedgerEntry.fromXDR(value, 'base64').data().contractData()
}

module.exports = {parseStateData, encodeContractId}