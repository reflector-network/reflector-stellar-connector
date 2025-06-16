const {Asset} = require('@stellar/stellar-sdk')

/**
 * Parse raw XDR result
 * @param {TransactionResult} result
 * @param {string} txHash
 * @return {Trade[]|null}
 */
function xdrParseResult(result, txHash) {
    const innerResult = result.result()
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
    } catch (e) {
        console.error(new Error([e], 'Error processing tx ' + txHash))
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
        amountSold: value.amountSold()._value,
        amountBought: value.amountBought()._value
    }
    if (!res.amountSold || !res.amountBought)
        return null
    res.assetSold = Asset.fromOperation(value.assetSold()).toString()
    res.assetBought = Asset.fromOperation(value.assetBought()).toString()
    return res
}

module.exports = {xdrParseResult}

/**
 * @typedef {{}} Trade
 * @property {BigInt} amountSold
 * @property {BigInt} amountBought
 * @property {string} assetSold
 * @property {string} assetBought
 * @property {'offer'|'pool'} type
 */