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
 * @return {Uint8Array}
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
    return encodeXDRAssetToContractId(convertToStellarAsset(asset).toXdrObject(), networkPassphrase)
}

function encodeXDRAssetToContractId(xdrAsset, networkPassphrase) {
    const assetContractId = new xdr.HashIdPreimageContractId({
        networkId: getNetworkIdHash(networkPassphrase),
        contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAsset(xdrAsset)
    })
    const preimage = xdr.HashIdPreimage.envelopeTypeContractId(assetContractId)
    return StrKey.encodeContract(hash(preimage.toXdr()))
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
 * Host of an RPC url, for logs: a paid endpoint often carries an api key in the path or query
 * @param {string} url - rpc url
 * @returns {string} host, or `invalid-url` when it cannot be parsed
 */
function rpcHost(url) {
    try {
        return new URL(url).host
    } catch (e) {
        return 'invalid-url'
    }
}

//The url that answered last, per configured url list. Without it every request walked the list in configured order, so a
//first url that hangs cost its whole deadline on every request, and a pool snapshot that has to finish within seconds of
//the boundary could not. The same helper lives in reflector-shared helpers/entries-helper.js, oracle-client
//src/rpc-helper.js and reflector-node src/utils/rpc-helper.js. Each node already reads from its own configured urls,
//and a snapshot is proven by ledger numbers and close times, so the preference changes which url answers, not what a
//node reports
const lastGoodUrls = new Map()
//distinct url lists one process uses: one per network
const maxRememberedUrlLists = 16
//a preference is dropped this long after it was set, so the configured order - the primary first - is tried again: a
//node that failed over once would otherwise stay on a secondary that lags the primary long after the primary recovered
const urlPreferenceTtl = 10 * 60 * 1000

/**
 * @param {string[]} urls - configured urls
 * @returns {string[]} the url that answered last first, then the others in configured order; the configured order
 * alone once the preference is older than urlPreferenceTtl
 */
function orderByLastGood(urls) {
    const key = urls.join('\n')
    const preferred = lastGoodUrls.get(key)
    const index = preferred ? urls.indexOf(preferred.url) : -1
    if (index < 0)
        return urls
    if (Date.now() - preferred.since >= urlPreferenceTtl) {
        lastGoodUrls.delete(key)
        return urls
    }
    //only the first occurrence moves: a url listed twice is still asked twice, so a failing request makes as many
    //attempts as it did without the preference
    return [urls[index], ...urls.slice(0, index), ...urls.slice(index + 1)]
}

/**
 * @param {string[]} urls - configured urls
 * @param {string} url - the url that answered
 */
function rememberGoodUrl(urls, url) {
    const key = urls.join('\n')
    const previous = lastGoodUrls.get(key)
    //the time is kept while the same url keeps answering, so a preference still expires ten minutes after it was set
    const since = previous && previous.url === url ? previous.since : Date.now()
    //deleted and set again, so the first entry is always the list used longest ago
    lastGoodUrls.delete(key)
    lastGoodUrls.set(key, {url, since})
    if (lastGoodUrls.size > maxRememberedUrlLists)
        lastGoodUrls.delete(lastGoodUrls.keys().next().value)
}

/**
 * Invokes Stellar RPC method directly, starting at the url that answered last
 * @param {string[]} rpcs - RPC URLs
 * @param {string} method - RPC method name
 * @param {{}} params - Parameters to pass to RPC
 * @param {{[timeout], [signal], [validateResult]}} [options] - request timeout, abort signal, and a validator that rejects an unusable answer
 * @return {Promise<any>}
 */
async function invokeRpcMethod(rpcs, method, params = undefined, options = undefined) {
    for (let i = 0; i < 3; i++) { //max 3 attempts
        try {
            const errAggr = []
            for (const rpcUrl of orderByLastGood(rpcs)) {
                let timeOut = null
                try {
                //eslint-disable-next-line prefer-const
                    let {timeout = 15_000, signal, validateResult} = options || {}
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
                    if (!res.ok) {
                        throw new Error(`RPC error: ${res.status} ${res.statusText}`)
                    }
                    const data = await res.json()
                    if (data.error)
                        throw new Error('RPC error: ' + data.error.message)
                    //a URL whose answer fails validation counts as a failed URL, so the next one is tried
                    if (validateResult)
                        validateResult(data.result, rpcUrl)
                    rememberGoodUrl(rpcs, rpcUrl)
                    return data.result
                } catch (e) {
                    let error = e
                    if (error.message.indexOf('RPC error: ') === 0) {//cleanup
                        error = error.message
                    }
                    errAggr.push({host: rpcHost(rpcUrl), err: error})
                } finally {
                    if (timeOut) {
                        clearTimeout(timeOut)
                    }
                }
            }
            throw new Error('Failed to invoke RPC method on all provided URLs', {cause: {errAggr, params, options}})
        } catch (e) {
            if (i === 2) {
                throw e
            }
            console.warn({msg: 'RPC call failed, retrying', method, attempt: i + 1, err: e?.cause?.errAggr || e.message})
        }
        await new Promise(resolve => setTimeout(resolve, 300))
    }
}

/**
 * Key of a (base, asset) pair in the set of pairs whose pools discovery tried
 * @param {string} baseAsset - base asset of the pair; the cross asset on the cross path
 * @param {string} asset - tracked asset
 * @return {string}
 */
function poolPairKey(baseAsset, asset) {
    return `${baseAsset}|${asset}`
}

module.exports = {
    invokeRpcMethod,
    poolPairKey,
    rpcHost,
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