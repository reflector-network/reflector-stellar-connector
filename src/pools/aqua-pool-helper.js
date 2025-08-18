const {scValToNative} = require('@stellar/stellar-sdk')
const {DEFAULT_DECIMALS, adjustPrecision} = require('../utils')

/**
 * Returns native storage
 * @param {xdr.ContractDataEntry} contractEntry - contract data entry
 * @param {string[]} [keys] - keys to extract from storage (optional)
 * @returns {object}
 */
function getAquaPoolContractValues(contractEntry, keys = []) {
    if (!contractEntry) {
        throw new Error('Contract entry is required')
    }
    if (!Array.isArray(keys)) {
        throw new Error('Keys should be an array of strings')
    }
    const data = contractEntry.val.contractData().val().instance()
    if (!data)
        return {}
    const storage = {}
    const entries = data.storage()
    for (const entry of entries) {
        const key = scValToNative(entry.key())
        if (keys.length > 0 && !keys.includes(key[0])) //key[0] because keys are stored as arrays in Aqua contracts
            continue
        const val = scValToNative(entry.val())
        storage[key] = val
    }
    return storage
}

const numberOfCoins = 2 //we only support 2-token pools
const numberOfCoinsBigInt = BigInt(numberOfCoins)

/**
 * Calculate the amount of token `j` that will be received for swapping `dx` of token `i`
 * @param {number} assetToSell - The index of the token being swapped
 * @param {number} assetToBuy - The index of the token being received
 * @param {bigint} amountToSell - The amount of tokens to swap
 * @param {bigint[]} reserves - Pool reserves
 * @param {bigint} fee - The fee to be applied to the swap (in basis points, e.g. 30 for 0.3%)
 * @param {bigint} amp - The amplification coefficient
 * @return {bigint} The amount of tokens that will be received
 * @private
 */
function calculateDy(assetToSell, assetToBuy, amountToSell, reserves, fee, amp) {
    const x = reserves[assetToSell] + amountToSell
    const y = get_y(assetToSell, assetToBuy, x, reserves, amp)
    if (y === 0n) //pool is empty
        return 0n
    const dy = reserves[assetToBuy] - y - 1n
    const current_fee = fee * dy / 10000n
    return dy - current_fee
}

/**
 * Calculates the amount of token `j` that will be received for swapping `dx` of token `i`
 * @param {number} in_idx - The index of the token being swapped
 * @param  {number} out_idx - The index of the token being received
 * @param {bigint} x - The amount of token `i` being swapped
 * @param {bigint[]} reserves - Pool reserves
 * @param {bigint} amp - The amplification coefficient
 * @return {bigint} The amount of token `j` that will be received
 * @private
 */
function get_y(in_idx, out_idx, x, reserves, amp) {
    if (in_idx === out_idx)
        throw new Error('Cannot swap the same token')
    if (out_idx >= numberOfCoins || in_idx >= numberOfCoins)
        throw new Error('Token index out of bounds')

    const d = compute_d(reserves, amp)
    let c = d
    let s = 0n
    const ann = amp * numberOfCoinsBigInt

    let x1
    for (let i = 0; i < numberOfCoins; i++) {
        if (i === in_idx) {
            x1 = x
        } else if (i !== out_idx) {
            x1 = reserves[i]
        } else
            continue
        s += x1
        c = c * d / (x1 * numberOfCoinsBigInt)
    }
    const c_256 = c * d / (ann * numberOfCoinsBigInt)
    const b = s + d / ann //- D
    let y_prev
    let y = d
    for (let i = 0; i < 255; i++) {
        y_prev = y
        y = (y * y + c_256) / (numberOfCoinsBigInt * y + b - d)

        //Equality with the precision of 1
        if (y > y_prev) {
            if (y - y_prev <= 1n)
                break
        } else if (y_prev - y <= 1n)
            break
    }
    return y
}

/**
 * Calculates the current amplification coefficient `A`
 * @param {bigint} initialA - Initial amplification coefficient
 * @param {number} initialATime - Timestamp when the initial amplification coefficient was set
 * @param {bigint} futureA - Future amplification coefficient
 * @param {number} futureATime - Timestamp when the future amplification coefficient will be set
 * @return {bigint} The current amplification coefficient
 * @private
 */
function a(initialA, initialATime, futureA, futureATime) {
    //Handle ramping A up or down
    const t1 = futureATime
    const a1 = futureA
    const now = Math.floor(new Date().getTime() / 1000) + 5 //adding 5 seconds to account for the possible future change
    if (now >= t1) //when t1 == 0 or block.timestamp >= t1
        return a1
    const a0 = initialA
    const t0 = initialATime
    //Expressions in u128 cannot have negative numbers, thus "if"
    const denominator = t1 - t0
    const timespan = now - t0
    if (a1 > a0) {
        return a0 + (a1 - a0) * timespan / denominator
    }
    return a0 - (a0 - a1) * timespan / denominator
}

/**
 * Calculates the invariant `D` for the given token balances
 * @param {bigint[]} reserves - The balances of each token in the pool
 * @param {bigint} amp - The amplification coefficient
 * @return {bigint} The invariant `D`
 * @private
 */
function compute_d(reserves, amp) {
    let s = 0n
    for (const x of reserves) {
        s += x
    }
    if (s === 0n)
        return 0n


    let d_prev
    let d = s
    const ann = amp * numberOfCoinsBigInt
    for (let i = 0; i < 255; i++) {
        let d_p = d
        for (const x1 of reserves) {
            d_p = d_p * d / (x1 * numberOfCoinsBigInt)
        }
        d_prev = d
        d = (ann * s + d_p * numberOfCoinsBigInt) * d / ((ann - 1n) * d + (numberOfCoinsBigInt + 1n) * d_p)

        //Equality with the precision of 1 stroop
        if (d > d_prev) {
            if (d - d_prev <= 1n)
                break
        } else if (d_prev - d <= 1n)
            break
    }
    return d
}

/**
 * Calculate the price of the pool based on the reserves and stable data
 * @param {BigInt[]} reserves - Array of reserves, first element is base asset reserve, second is quote asset reserve
 * @param {Object} stableData - Stable pool data containing initial and future amplification coefficients and fee
 * @returns {BigInt} - The calculated price in the quote asset
 */
function calculatePrice(reserves, stableData) {
    const sellReserve = reserves[0]
    const buyReserve = reserves[1]
    if (sellReserve === 0n || buyReserve === 0n) {
        throw new Error('Invalid reserves')
    }
    const amp = a(stableData.initialA, stableData.initialATime, stableData.futureA, stableData.futureATime)
    if (amp === 0n) {
        throw new Error('Invalid amplification coefficient')
    }
    const aDy = calculateDy(0, 1, BigInt(Math.pow(10, 14)), reserves, stableData.fee, amp)
    const bDy = calculateDy(1, 0, BigInt(Math.pow(10, 14)), reserves, stableData.fee, amp)
    return (aDy + BigInt(Math.pow(10, 14 * 2)) / bDy) / 2n
}

/**
 * Processes aquarius pool contracts
 * @param {ContractDataEntry} contractData - contracts data entries
 * @param {string} baseTokenId - base token contract id
 * @param {Map<string, string>} quoteTokenIds - quote token contract ids
 * @return {{reserves: BigInt[], token: string}} - reserves array. First element is base asset reserve, second is quote asset reserve.
 */
function extractAquaPoolData(contractData, baseTokenId, quoteTokenIds) {
    const storage = getAquaPoolContractValues(contractData, ['ReserveA', 'ReserveB', 'Reserves', 'Decimals', 'Tokens', 'TokenA', 'TokenB', 'InitialA', 'InitialATime', 'FutureA', 'FutureATime', 'Fee'])
    const digits = storage.Decimals !== undefined ? storage.Decimals : [DEFAULT_DECIMALS, DEFAULT_DECIMALS]
    const reserves = storage.ReserveA !== undefined
        ? [storage.ReserveA, storage.ReserveB]
        : [storage.Reserves[0], storage.Reserves[1]]
    const tokens = storage.Tokens || [storage.TokenA, storage.TokenB]
    if (
        !tokens //no tokens found
        || new Set(tokens).size !== 2 //not exactly 2 unique tokens
        || !tokens.includes(baseTokenId) //base token not found in pool
        || !quoteTokenIds.has(tokens.find(t => t !== baseTokenId)) //quote token not found
    ) {
        return {} //unable to extract reserves
    }
    reserves[0] = adjustPrecision(reserves[0], digits[0])
    reserves[1] = adjustPrecision(reserves[1], digits[1])
    if (tokens[1] === baseTokenId) //check if base token is second in the list
        reserves.reverse() //ensure base token is always first
    let stableData = undefined
    if (storage.InitialA) {
        stableData = {
            initialA: storage.InitialA,
            initialATime: storage.InitialATime,
            futureA: storage.FutureA,
            futureATime: storage.FutureATime,
            fee: BigInt(storage.Fee)
        }
    }
    return {reserves, token: tokens.find(t => t !== baseTokenId), stableData}
}

module.exports = {
    getAquaPoolContractValues,
    extractAquaPoolData,
    calculatePrice
}