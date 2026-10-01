const {StrKey} = require('@stellar/stellar-sdk')
const {DEFAULT_DECIMALS, adjustPrecision} = require('../../utils')
const {extractInstanceStorage, getContractInstanceValues} = require('../utils')

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
 * @param {bigint} initialATime - Timestamp when the initial amplification coefficient was set
 * @param {bigint} futureA - Future amplification coefficient
 * @param {bigint} futureATime - Timestamp when the future amplification coefficient will be set
 * @param {number} periodTimestamp - Period timestamp in seconds; every node derives the same value, unlike the wall clock
 * @return {bigint} The current amplification coefficient
 * @private
 */
function a(initialA, initialATime, futureA, futureATime, periodTimestamp) {
    if (!Number.isFinite(periodTimestamp) || periodTimestamp <= 0)
        throw new Error('Period timestamp is required to compute the amplification coefficient')
    //Handle ramping A up or down
    const t1 = futureATime
    const a1 = futureA
    const now = BigInt(Math.floor(periodTimestamp))
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
 * Calculate the price of the pool based on the reserves and stable data.
 * Probes the swap math with 1% of the smaller reserve, so the estimate stays close
 * to the marginal price regardless of pool depth.
 * @param {BigInt[]} reserves - Array of reserves, first element is base asset reserve, second is quote asset reserve
 * @param {Object} stableData - Stable pool data containing initial and future amplification coefficients and fee
 * @param {number} periodTimestamp - Period timestamp in seconds, used for the amplification ramp
 * @returns {BigInt} - The calculated price in the quote asset
 */
function calculatePrice(reserves, stableData, periodTimestamp) {
    const sellReserve = reserves[0]
    const buyReserve = reserves[1]
    if (sellReserve === 0n || buyReserve === 0n) {
        throw new Error('Invalid reserves')
    }
    const amp = a(stableData.initialA, stableData.initialATime, stableData.futureA, stableData.futureATime, periodTimestamp)
    if (amp === 0n) {
        throw new Error('Invalid amplification coefficient')
    }
    //10 ^ 14
    const tenToFourteen = 10n ** 14n
    const probe = (sellReserve < buyReserve ? sellReserve : buyReserve) / 100n
    if (probe === 0n) //pool too shallow to derive a meaningful probe
        return 0n
    const aDy = calculateDy(0, 1, probe, reserves, stableData.fee, amp)
    const bDy = calculateDy(1, 0, probe, reserves, stableData.fee, amp)
    //pool too shallow to price the probe swap in either direction
    if (aDy <= 0n || bDy <= 0n)
        return 0n
    return (aDy * tenToFourteen / probe + probe * tenToFourteen / bDy) / 2n
}

/**
 * Resolve per-token decimals, preferring what the token contracts themselves reported over the pool's own claim
 * @param {string[]} tokens - pool token contract ids
 * @param {any} declared - `Decimals` value declared in pool storage, if any
 * @param {Map<string, {decimals: number}>} tokenMeta - metadata loaded from the token contracts
 * @returns {number[]|null}
 */
function resolveDigits(tokens, declared, tokenMeta) {
    const declaredDigits = Array.isArray(declared) && declared.length === 2 ? declared.map(Number) : null
    const digits = []
    for (let i = 0; i < 2; i++) {
        const meta = tokenMeta.get(tokens[i])
        const own = declaredDigits ? declaredDigits[i] : undefined
        if (meta) {
            //an entry without decimals is the failed-decimals() marker - the pool cannot be scaled safely
            if (!Number.isInteger(meta.decimals))
                return null
            if (own !== undefined && own !== meta.decimals) {
                console.warn({msg: 'Pool declares decimals the token contract disagrees with', token: tokens[i], declared: own, actual: meta.decimals})
                return null
            }
            digits.push(meta.decimals)
            continue
        }
        if (own === undefined) {
            digits.push(DEFAULT_DECIMALS)
            continue
        }
        if (!Number.isInteger(own) || own < 0 || own > 18) {
            console.warn({msg: 'Pool declares an unusable decimals value', token: tokens[i], declared: own})
            return null
        }
        digits.push(own)
    }
    return digits
}

/**
 * Processes aquarius pool contracts
 * @param {ContractDataEntry} contractData - contracts data entries
 * @param {Map<string, {decimals: number}>} tokenMeta - Metadata for tokens to aggregate pools data for
 * @return {{reserves: BigInt[], tokens: string[], stableData: {initialA: bigint, initialATime: bigint, futureA: bigint, futureATime: bigint, fee: bigint}}} - reserves array. First element is base asset reserve, second is quote asset reserve.
 */
function extractAquaPoolData(contractData, tokenMeta) {
    const storage = getContractInstanceValues(extractInstanceStorage(contractData), ['ReserveA', 'ReserveB', 'Reserves', 'Reserve0', 'Reserve1', 'Decimals', 'Tokens', 'TokenA', 'TokenB', 'Token0', 'Token1', 'Slot0', 'InitialA', 'InitialATime', 'FutureA', 'FutureATime', 'Fee'])
    let reserves
    let tokens
    if (storage.Reserve0 !== undefined) { //concentrated pool
        reserves = [storage.Reserve0, storage.Reserve1]
        tokens = [storage.Token0, storage.Token1]
    } else {
        reserves = storage.ReserveA !== undefined
            ? [storage.ReserveA, storage.ReserveB]
            : [storage.Reserves[0], storage.Reserves[1]]
        tokens = storage.Tokens || [storage.TokenA, storage.TokenB]
    }
    if (
        !tokens //no tokens found
        || new Set(tokens).size !== 2 //not exactly 2 unique tokens
        || !tokens.every(t => typeof t === 'string' && StrKey.isValidContract(t)) //self-declared tokens must at least be contract ids
    ) {
        return null //unable to extract reserves
    }

    const digits = resolveDigits(tokens, storage.Decimals, tokenMeta)
    if (!digits)
        return null //decimals cannot be trusted - pricing this pool would mis-scale it
    reserves[0] = adjustPrecision(reserves[0], digits[0])
    reserves[1] = adjustPrecision(reserves[1], digits[1])
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
    let concentratedData = undefined
    if (storage.Slot0) {
        concentratedData = {sqrtPriceX96: storage.Slot0.sqrt_price_x96, digits: [...digits]}
    }
    return {reserves, tokens, stableData, concentratedData}
}

module.exports = {
    extractAquaPoolData,
    calculatePrice
}