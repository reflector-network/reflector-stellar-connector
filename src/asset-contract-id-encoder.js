const {Asset, StrKey, hash, xdr} = require('@stellar/stellar-base')

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

module.exports = {encodeAssetContractId}