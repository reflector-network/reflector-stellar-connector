const {Asset, StrKey, hash, xdr} = require('@stellar/stellar-sdk')

/**
 * Default number of decimals for price calculations
 * @type {number}
 * @constant
 */
const DEFAULT_DECIMALS = 7

/**
 * Target number of decimals for price calculations
 * @type {number}
 * @constant
 */
const TARGET_DECIMALS = 14

/**
 * Calculate price from volume and quote volume
 * @param {BigInt} volume - volume
 * @param {BigInt} quoteVolume - quote volume
 * @param {number} [decimals] - number of decimals to scale the result (default is TARGET_DECIMALS = 14)
 * @returns {BigInt}
 */
function getVWAP(volume, quoteVolume, decimals = TARGET_DECIMALS) {
    if (typeof volume !== 'bigint')
        throw new Error('volume should be expressed as BigInt')
    if (typeof quoteVolume !== 'bigint')
        throw new Error('quoteVolume should be expressed as BigInt')
    if (typeof decimals !== 'number' || isNaN(decimals))
        throw new Error('decimals should be expressed as Number')
    const scaledtotalVolume = volume * (10n ** BigInt(decimals)) //multiply decimals by 10^decimals to get correct price
    if (quoteVolume === 0n || scaledtotalVolume === 0n)
        return 0n
    return scaledtotalVolume / quoteVolume
}

/**
 * Convert value to BigInt with specified number of decimals
 * @param {BigInt} value - value
 * @param {number} decimals - number of decimals
 * @returns {BigInt}
 */
function scaleValue(value, decimals) {
    if (typeof value !== 'bigint')
        throw new Error('Value should be expressed as BigInt')
    if (typeof decimals !== 'number' || isNaN(decimals))
        throw new Error('Decimals should be expressed as Number')
    if (value === 0n)
        return 0n
    return value * (10n ** BigInt(decimals))
}

/**
 * Normalize timestamp to the nearest timeframe
 * @param {number} timestamp - timestamp
 * @param {number} timeframe - timeframe to normalize to
 * @returns {number} - normalized timestamp
 */
function normalizeTimestamp(timestamp, timeframe) {
    return Math.floor(timestamp / timeframe) * timeframe
}

const passphraseMapping = {}

/**
 * Resolve network id hash from a passphrase (with pre-caching)
 * @param {String} networkPassphrase - network passphrase (e.g. Networks.PUBLIC)
 * @return {Buffer}
 */
function getNetworkIdHash(networkPassphrase) {
    let networkId = passphraseMapping[networkPassphrase]
    if (!networkId) {
        networkId = passphraseMapping[networkPassphrase] = hash(Buffer.from(networkPassphrase))
    }
    return networkId
}

/**
 * Encode ContractId for a given wrapped Stellar classic asset
 * @param {string} asset - stellar asset code in 'code:issuer' format, or XLM for native, or contract ID for already wrapped assets
 * @param {String} networkPassphrase - network passphrase (e.g. Networks.PUBLIC)
 * @return {String}
 */
function encodeAssetContractId(asset, networkPassphrase) {
    if (StrKey.isValidContract(asset?.toString()))
        return asset.toString()
    return encodeXDRAssetToContractId(convertToStellarAsset(asset).toXDRObject(), networkPassphrase)
}

function encodeXDRAssetToContractId(xdrAsset, networkPassphrase) {
    const assetContractId = new xdr.HashIdPreimageContractId({
        networkId: getNetworkIdHash(networkPassphrase),
        contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAsset(xdrAsset)
    })
    const preimage = xdr.HashIdPreimage.envelopeTypeContractId(assetContractId)
    return StrKey.encodeContract(hash(preimage.toXDR()))
}


/**
 * Convert asset descriptor to Stellar Asset
 * @param {string} asset - oracle asset object. Code should be in 'code:issuer' format.
 * @return {Asset|null}
 */
function convertToStellarAsset(asset) {
    const [assetCode, issuer] = asset.split(':')
    if (!assetCode)
        throw new Error(`Asset code is required`)
    if ((assetCode === 'XLM' || assetCode === 'native') && !issuer)
        return Asset.native()
    else if (assetCode && issuer)
        return new Asset(assetCode, issuer)
    throw new Error(`Invalid asset code format: ${asset}. Expected 'code:issuer' format.`)
}

/**
 * Normalize value to a fixed precision
 *
 * @param {BigInt} value - value to normalize
 * @param {number} digits - number of digits in the value
 * @param {number} [targetDigits] - target number of digits for normalization (default is TARGET_DECIMALS = 14)
 * @returns {BigInt} - normalized value
 */
function adjustPrecision(value, digits, targetDigits = TARGET_DECIMALS) {
    if (typeof value !== 'bigint') {
        throw new Error('Value should be expressed as BigInt')
    }
    if (typeof digits !== 'number' || isNaN(digits) || digits < 0) {
        throw new Error('Digits should be a non-negative number')
    }
    if (typeof targetDigits !== 'number' || isNaN(targetDigits) || targetDigits < 0) {
        throw new Error('Target digits should be a non-negative number')
    }
    const diff = targetDigits - digits

    if (diff === 0) return value
    const absDiff = BigInt(Math.abs(diff))
    if (diff > 0) {
        return value * 10n ** absDiff
    } else {
        return value / 10n ** absDiff
    }
}

/**
 * Invokes Stellar RPC method directly
 * @param {string[]} rpcs - RPC URLs
 * @param {string} method - RPC method name
 * @param {{}} params - Parameters to pass to RPC
 * @param {{[timeout], [signal]}} [options]
 * @return {Promise<any>}
 */
async function invokeRpcMethod(rpcs, method, params = undefined, options = undefined) {
    for (let i = 0; i < 3; i++) { //max 3 attempts
        try {
            const errAggr = []
            for (const rpcUrl of rpcs) {
                let timeOut = null
                try {
                //eslint-disable-next-line prefer-const
                    let {timeout = 15_000, signal} = options || {}
                    if (!signal) {
                        const abortController = new AbortController()
                        timeOut = setTimeout(() => abortController.abort(), timeout)
                        signal = abortController.signal
                    }
                    const res = await fetch(rpcUrl, {
                        method: 'POST',
                        body: JSON.stringify({
                            jsonrpc: '2.0',
                            id: 8675309,
                            method,
                            params
                        }),
                        headers: {'Content-Type': 'application/json'},
                        signal
                    })
                    const data = await res.json()
                    if (data.error)
                        throw new Error('RPC error: ' + data.error.message)
                    return data.result
                } catch (e) {
                    errAggr.push({url: rpcUrl, err: e})
                } finally {
                    if (timeOut) {
                        clearTimeout(timeOut)
                    }
                }
            }
            throw new Error('Failed to invoke RPC method on all provided URLs', {cause: errAggr, params, options})
        } catch (e) {
            if (i === 2) {
                throw e
            }
        }
    }
}

module.exports = {
    invokeRpcMethod,
    getVWAP,
    normalizeTimestamp,
    encodeAssetContractId,
    encodeXDRAssetToContractId,
    convertToStellarAsset,
    adjustPrecision,
    scaleValue,
    DEFAULT_DECIMALS,
    TARGET_DECIMALS
}