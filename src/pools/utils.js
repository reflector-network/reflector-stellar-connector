const {xdr, scValToNative} = require('@stellar/stellar-sdk')
const {TARGET_DECIMALS, adjustPrecision} = require('../utils')

function extractInstanceStorage(instance) {
    let storageData = null
    try {
        storageData = xdr.LedgerEntryData.fromXdr(instance, 'base64')
    } catch (e) {
        try {
            storageData = xdr.LedgerEntryData.contractData(xdr.ContractDataEntry.fromXdr(instance, 'base64'))
        } catch (e) {
            storageData = xdr.LedgerEntryData.liquidityPool(xdr.LiquidityPoolEntry.fromXdr(instance, 'base64'))
        }
    }
    return storageData
}

/**
 * Returns native contract instance storage values
 * @param {xdr.LedgerEntryData} contractEntry - contract data entry
 * @param {string[]} [keys] - keys to extract from storage (optional)
 * @returns {object}
 */
function getContractInstanceValues(contractEntry, keys = []) {
    if (!contractEntry) {
        throw new Error('Contract entry is required')
    }
    if (!Array.isArray(keys)) {
        throw new Error('Keys should be an array of strings')
    }
    const data = contractEntry.value.val.instance
    if (!data)
        return {}
    const storage = {}
    const entries = data.storage
    for (const entry of entries) {
        const key = scValToNative(entry.key)
        //Aqua contracts store keys as single-element vectors, SushiSwap as plain symbols
        const keyName = Array.isArray(key) ? key[0] : key
        if (keys.length > 0 && !keys.includes(keyName))
            continue
        const val = scValToNative(entry.val)
        storage[keyName] = val
    }
    return storage
}

/**
 * Calculate the price of a concentrated liquidity pool from its current sqrt price
 * @param {{sqrtPriceX96: BigInt, digits: number[]}} concentratedData - sqrt price (X96 fixed-point) and per-token decimals
 * @returns {BigInt} - price of token0 expressed in token1, scaled to TARGET_DECIMALS
 */
function calculateConcentratedPrice(concentratedData) {
    const {sqrtPriceX96, digits} = concentratedData
    if (!sqrtPriceX96 || sqrtPriceX96 <= 0n)
        return 0n
    //price = (sqrtPriceX96 / 2^96)^2 in raw token units, restated at TARGET_DECIMALS with the decimals difference applied
    const exponent = TARGET_DECIMALS + digits[0] - digits[1]
    const squared = sqrtPriceX96 * sqrtPriceX96
    if (exponent >= 0)
        return squared * 10n ** BigInt(exponent) / 2n ** 192n
    return squared / (2n ** 192n * 10n ** BigInt(-exponent))
}

/**
 * Convert pool reserves into volumes capped by the shallower side, so downstream VWAP
 * yields the given pool price while weighting the pool by its actual depth
 * @param {BigInt[]} reserves - pool reserves normalized to TARGET_DECIMALS
 * @param {BigInt} price - pool price of token0 expressed in token1, scaled to TARGET_DECIMALS
 * @returns {BigInt[]} - [token0 volume, token1 volume], the min side kept as-is and the other slot carrying its value at the price
 */
function calculatePoolVolumes(reserves, price) {
    const one = adjustPrecision(1n, 0)
    const value0 = reserves[0] * price / one //token0 reserve valued in token1 terms
    if (value0 <= reserves[1])
        return [reserves[0], value0]
    return [reserves[1] * one / price, reserves[1]]
}

module.exports = {
    extractInstanceStorage,
    getContractInstanceValues,
    calculateConcentratedPrice,
    calculatePoolVolumes
}
