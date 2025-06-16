const {scValToNative, StrKey} = require('@stellar/stellar-sdk')
const {DEFAULT_DECIMALS, adjustPrecision} = require('../utils')
const PoolType = require('./pool-type')

/**
 * @typedef {import('@stellar/stellar-sdk').xdr.ContractDataEntry} ContractDataEntry
 */

/**
 * Returns native storage
 * @param {xdr.ScMapEntry[]} values - values
 * @returns {object}
 */
function getNativeStorage(values) {
    const storage = {}
    if (values)
        for (const value of values) {
            const key = scValToNative(value.key())
            const val = scValToNative(value.val())
            storage[key] = val
        }
    return storage
}

/**
 * Processes aquarius pool contracts
 * @param {{contracts: Map<string, {type: string, baseAssetIndex: number, asset: string}>, dataPromise: Promise<{entries: ContractDataEntry[]}>}} contractsData - contracts data. Map of contract IDs to contract type.
 * @return {Promise<{reserves: BigInt[], token: string}[]>} - Map of contract ID to reserves array. First element is base token reserve, second is quote token reserve.
 */
async function processPoolData(contractsData) {
    const poolsData = await contractsData.dataPromise
    const processedData = []
    for (const pool of poolsData.entries) {
        const contractId = StrKey.encodeContract(pool.key.contractData().contract().contractId())
        const {type, baseAssetIndex, asset} = contractsData.contracts.get(contractId)
        if (!type) {
            console.warn(`Skipping ${contractId}. No contract type found`)
            continue
        }
        let data = null
        switch (type) {
            case PoolType.AQUA:
                data = {
                    reserves: extractAquaPoolData(pool, baseAssetIndex),
                    asset
                }
                break
            default:
                console.warn(`Unknown contract type for ${contractId}: ${type}`)
                continue
        }
        if (data)
            processedData.push(data)
    }
    console.debug(`Processed ${processedData.length} pools`)
    return processedData
}

const hasValue = (val) => !(val === null || val === undefined || val === '')

/**
 * Processes aquarius pool contracts
 * @param {ContractDataEntry} contractData - contracts data entries
 * @param {string} baseAssetIndex - base asset index
 * @return {BigInt[]} - reserves array. First element is base asset reserve, second is quote asset reserve.
 */
function extractAquaPoolData(contractData, baseAssetIndex) {
    const data = contractData.val.contractData().val().instance()
    if (!data)
        return null
    const storage = getNativeStorage(data.storage())
    const digits = hasValue(storage.Decimals) ? storage.Decimals : [DEFAULT_DECIMALS, DEFAULT_DECIMALS]
    const reserves = hasValue(storage.ReserveA)
        ? [storage.ReserveA, storage.ReserveB]
        : [storage.Reserves[0], storage.Reserves[1]]
    if (baseAssetIndex === 1)
        reserves.reverse() //ensure base token is always first
    reserves[0] = adjustPrecision(reserves[0], digits[0])
    reserves[1] = adjustPrecision(reserves[1], digits[1])
    return reserves
}

module.exports = {
    processPoolData
}