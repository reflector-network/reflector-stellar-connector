const {StrKey, xdr, scValToBigInt} = require('stellar-base')
const {protocolVersion} = require('./protocol-version')

/**
 * Retrieve and parse contract state data
 * @param {ContractStateRawData} contractData - Contract data state retrieved from StellarCore db
 * @param {Number} [expectedProtocolVersion] - Provider protocol version
 * @return {{admin: String, lastTimestamp: BigInt, prices: BigInt[]}}
 */
function parseStateData(contractData, expectedProtocolVersion = protocolVersion) {
    const contractProtocolVersion = parseStateLedgerEntry(contractData.version).body().data().val().u32()
    if (contractProtocolVersion > expectedProtocolVersion)
        throw new Error(`Unsupported protocol version. Data provider protocol version: ${expectedProtocolVersion}, contract protocol version: ${contractProtocolVersion}.`)

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
        admin: StrKey.encodeEd25519PublicKey(parseStateLedgerEntry(contractData.admin).body().data().val().address().accountId().ed25519()),
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

/**
 * @param {String} rawSigners
 * @return {{address: String, weight: Number}[]}
 */
function parseAccountSigners(rawSigners) {
    const signers = []
    if (!rawSigners)
        return signers
    const buf = Buffer.from(rawSigners, 'base64')
    const length = buf.readInt32BE(0)
    let pointer = 4
    for (let i = 0; i < length; i++) {
        if (buf.readInt32BE(pointer) !== 0)
            throw new Error('Unsupported signer type: ' + i)
        signers.push({
            address: StrKey.encodeEd25519PublicKey(buf.subarray(pointer + 4, pointer + 36)),
            weight: buf.readInt32BE(pointer + 36)
        })
        pointer += 40
    }
    return signers
}

module.exports = {parseStateData, encodeContractId, parseAccountSigners}