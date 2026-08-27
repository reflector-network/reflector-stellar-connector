const {Asset, xdr} = require('@stellar/stellar-sdk')
const {adjustPrecision} = require('../utils')

/**
 * @typedef {import('@stellar/stellar-sdk').xdr.TransactionResult} TransactionResult
 */

/**
 * @typedef {Object} Trade
 * @property {BigInt} amountSold
 * @property {BigInt} amountBought
 * @property {string} assetSold
 * @property {string} assetBought
 * @property {'offer'|'pool'} type
 */

/**
 * Parse raw XDR result
 * @param {any} tx - XDR result of the transaction
 * @return {Trade[]|null}
 */
function xdrParseResult(tx) {
    const innerResult = xdr.TransactionResult.fromXdr(tx.resultXdr, 'base64').result
    try {
        if (innerResult.type !== 'txSuccess' && innerResult.type !== 'txFeeBumpInnerSuccess') //failed tx
            return null
        let opResults
        if (innerResult.innerResultPair !== undefined) { //fee bump tx
            opResults = innerResult.innerResultPair.result.result.results
        } else { //regular tx
            opResults = innerResult.results
        }
        return (opResults || []).map(opR => parseRawOpResult(opR, tx.txHash)).flat().filter(v => !!v)
    } catch (err) {
        console.error({err, msg: 'Error processing tx', tx: tx.hash})
        return null
    }
}

function parseRawOpResult(rawOpResult, txHash) {
    const inner = rawOpResult.tr
    if (inner === undefined)
        return null //"opNoAccount" Case
    const opResult = inner.value
    switch (opResult.type) {
        case 'pathPaymentStrictReceiveSuccess':
        case 'pathPaymentStrictSendSuccess':
            return opResult.value.offers.map(claimedOffer => processDexTrade(claimedOffer, txHash))
        case 'manageSellOfferSuccess':
        case 'manageBuyOfferSuccess':
            return opResult.value.offersClaimed.map(claimedOffer => processDexTrade(claimedOffer, txHash))
        default:
            return null
    }
}

/**
 * Parse DEX trades from claimed offers
 * @param {xdr.ClaimAtom} claimedAtom - claimed atom from the operation
 * @param {string} txHash - transaction hash
 * @return {Trade|null}
 */
function processDexTrade(claimedAtom, txHash) {
    let type
    switch (claimedAtom.type) {
        case 'claimAtomTypeV0':
        case 'claimAtomTypeOrderBook':
            type = 'offer'
            break
        case 'claimAtomTypeLiquidityPool':
            type = 'pool'
            break
        default:
            throw new Error(`Unsupported claimed atom type: ` + claimedAtom.type)
    }
    const res = {
        type,
        //all trade amounts are in 7-digit precision, so we need to adjust them to get correct values
        amountSold: adjustPrecision(claimedAtom.value.amountSold, 7),
        amountBought: adjustPrecision(claimedAtom.value.amountBought, 7)
    }
    if (!res.amountSold || !res.amountBought)
        return null
    const getAssetCode = (asset) => {
        const assetCode = Asset.fromOperation(asset).toString()
        if (assetCode === 'native')
            return 'XLM'
        return assetCode
    }
    res.assetSold = getAssetCode(claimedAtom.value.assetSold)
    res.assetBought = getAssetCode(claimedAtom.value.assetBought)
    res.txHash = txHash
    return res
}

module.exports = {xdrParseResult}