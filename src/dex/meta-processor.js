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
    const innerResult = xdr.TransactionResult.fromXDR(tx.resultXdr, 'base64').result()
    const txResultState = innerResult.switch()
    if (txResultState.value < 0)
        return null //tx failed
    try {
        if (innerResult._switch.value < 0) //failed tx
            return null
        let opResults
        if (innerResult._arm === 'innerResultPair') { //fee bump tx
            opResults = innerResult.innerResultPair().result().result().results()
        } else { //regular tx
            opResults = innerResult.results()
        }
        return (opResults || []).map(parseRawOpResult).flat().filter(v => !!v)
    } catch (err) {
        console.error({err, msg: 'Error processing tx', tx: tx.hash})
        return null
    }
}

function parseRawOpResult(rawOpResult) {
    const inner = rawOpResult.tr()
    if (inner === undefined)
        return null //"opNoAccount" Case
    const opResult = inner.value()
    const successOpResultType = opResult.switch()
    switch (successOpResultType.name) {
        case 'pathPaymentStrictReceiveSuccess':
        case 'pathPaymentStrictSendSuccess':
            return opResult.value().offers().map(claimedOffer => processDexTrade(claimedOffer))
        case 'manageSellOfferSuccess':
        case 'manageBuyOfferSuccess':
            return opResult.value().offersClaimed().map(claimedOffer => processDexTrade(claimedOffer))
        default:
            return null
    }
}

/**
 * Parse DEX trades from claimed offers
 * @param {xdr.ClaimAtom} claimedAtom - claimed atom from the operation
 * @return {Trade|null}
 */
function processDexTrade(claimedAtom) {
    let type
    switch (claimedAtom.arm()) {
        case 'v0':
        case 'orderBook':
            type = 'offer'
            break
        case 'liquidityPool':
            type = 'pool'
            break
        default:
            throw new Error(`Unsupported claimed atom type: ` + claimedAtom.arm())
    }
    const value = claimedAtom.value()
    const res = {
        type,
        //all trade amounts are in 7-digit precision, so we need to adjust them to get correct values
        amountSold: adjustPrecision(value.amountSold()._value, 7),
        amountBought: adjustPrecision(value.amountBought()._value, 7)
    }
    if (!res.amountSold || !res.amountBought)
        return null
    res.assetSold = Asset.fromOperation(value.assetSold()).toString()
    res.assetBought = Asset.fromOperation(value.assetBought()).toString()
    return res
}

module.exports = {xdrParseResult}