const {Asset, StrKey, hash, xdr} = require('@stellar/stellar-sdk')

const passphraseMapping = {}

/**
 * Resolve network id hash from a passphrase (with pre-caching)
 * @param {String} networkPassphrase
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
 * @param {Asset} asset
 * @param {String} networkPassphrase
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
 * @param {{type:number,code:string,[issuer]:string}} asset
 * @return {Asset|null}
 */
function convertToStellarAsset(asset) {
    switch (asset.type) {
        case 1: // Stellar asset
            if (!asset.code)
                throw new Error(`Asset code is required`)
            const [code, issuer] = asset.code.split(':')
            if (code === 'XLM' && !issuer)
                return Asset.native()
            else if (code && issuer)
                return new Asset(code, issuer)
    }
    return null
}


module.exports = {encodeAssetContractId, convertToStellarAsset}