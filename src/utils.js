const {Asset, StrKey, hash, xdr, scValToNative} = require('@stellar/stellar-sdk')

/**
 * Default number of decimals for price calculations
 * @type {number}
 * @constant
 */
const DEFAULT_DECIMALS = 7

/**
 * Calculate price from volume and quote volume
 * @param {BigInt} volume - volume
 * @param {BigInt} quoteVolume - quote volume
 * @returns {BigInt}
 */
function getVWAP(volume, quoteVolume) {
    const preciseQuoteVolume = scaleValue(quoteVolume, 7) //multiply decimals by 2 to get correct price
    if (preciseQuoteVolume === 0n || volume === 0n)
        return 0n
    return preciseQuoteVolume / volume
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
 * @param {Asset} asset - stellar asset to encode
 * @param {String} networkPassphrase - network passphrase (e.g. Networks.PUBLIC)
 * @return {String}
 */
function encodeAssetContractId(asset, networkPassphrase) {
    const assetContractId = new xdr.HashIdPreimageContractId({
        networkId: getNetworkIdHash(networkPassphrase),
        contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAsset(asset.toXDRObject())
    })
    const preimage = xdr.HashIdPreimage.envelopeTypeContractId(assetContractId)
    return StrKey.encodeContract(hash(preimage.toXDR()))
}

/**
 * Convert asset descriptor to Stellar Asset
 * @param {{type:number, code:string}} asset - oracle asset object. Code should be in 'code:issuer' format.
 * @return {Asset|null}
 */
function convertToStellarAsset(asset) {
    switch (asset.type) {
        case 1: {//Stellar asset
            if (!asset.code)
                throw new Error(`Asset code is required`)
            const [code, issuer] = asset.code.split(':')
            if (code === 'XLM' && !issuer)
                return Asset.native()
            else if (code && issuer)
                return new Asset(code, issuer)
            else
                throw new Error(`Invalid asset code format: ${asset.code}. Expected 'code:issuer' format.`)
        }
        default:
            console.warn(`Unknown asset type: ${asset.type}. Expected 1 for Stellar asset.`)
    }
    return null
}

/**
 * Normalize value to a fixed precision
 *
 * @param {BigInt} value - value to normalize
 * @param {number} digits - number of digits in the value
 * @param {number} [targetDigits] - target number of digits for normalization (default is DEFAULT_DECIMALS)
 * @returns {BigInt} - normalized value
 */
function adjustPrecision(value, digits, targetDigits = DEFAULT_DECIMALS) {
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
    if (diff > 0) {
        return value * BigInt(10 ** diff)
    } else {
        return value / BigInt(10 ** (-diff))
    }
}


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

module.exports = {
    getVWAP,
    normalizeTimestamp,
    encodeAssetContractId,
    convertToStellarAsset,
    adjustPrecision,
    getAquaPoolContractValues,
    DEFAULT_DECIMALS
}