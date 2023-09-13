const {StrKey, xdr, scValToBigInt} = require('stellar-base')
const {adminPrefix, lastTimestampPrefix, admin: adminKey, lastTimestamp: lastTimestampKey} = require('./contract-state-keys')

/**
 * Retrieve and parse contract state data
 * @param {ContractStateRawData} contractData - Contract data state retrieved from StellarCore db
 * @return {{admin: String, lastTimestamp: BigInt, prices: BigInt[]}}
 */
function parseStateData(contractData) {
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
    const defaultValues = {
        admin: null,
        lastTimestamp: 0n,
        prices: [],
        uninitialized: true
    }

    if (!contractData.contractEntry)
        return defaultValues

    const { admin, lastTimestamp } = tryGetParsedStateData(contractData.contractEntry)
    if (!admin)
        return defaultValues

    return {
        admin: admin,
        lastTimestamp: lastTimestamp || 0n,
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

function tryGetParsedStateData(contractEntry) {
    let data = {}
    const containsAdmin = contractEntry.indexOf(adminPrefix) !== -1
    if (!containsAdmin)
        return data
    const containsLastTimestamp = contractEntry.indexOf(lastTimestampPrefix) !== -1
    const storage = parseStateLedgerEntry(contractEntry).body()?.value()?.val()?.value()?.storage()
    if (!storage)
        return data
    for (const entry of storage) {
        let key = entry.key().value().toString()
        if (key === adminKey)
            data.admin = StrKey.encodeEd25519PublicKey(entry.val().address().accountId().ed25519())
        else if (key === lastTimestampKey) {
            data.lastTimestamp = scValToBigInt(entry.val())
        }
        if (data.admin && (data.lastTimestamp || !containsLastTimestamp))
            break
    }
    return data
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