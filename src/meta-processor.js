const {xdr} = require('@stellar/stellar-base')

/**
 * Parse raw XDR result
 * @param {Buffer} resultXdr
 * @return {Trade[]|null}
 */
function xdrParseResult(resultXdr) {
    const parsed = xdr.TransactionResultPair.fromXDR(resultXdr)
    const innerResult = parsed.result().result()
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
        console.error(new AggregateError([e], 'Error processing tx ' + parsed.transactionHash().toString('hex')))
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
    }
    return null
}

/**
 * Parse DEX trades from claimed offers
 * @param {xdr.ClaimAtom} claimedAtom
 * @return {Trade}
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
    return {
        amountSold: BigInt(value.amountSold().toString()),
        amountBought: BigInt(value.amountBought().toString()),
        assetSold: value.assetSold(),
        assetBought: value.assetBought(),
        type
    }
}

module.exports = {xdrParseResult}

/**
 * @typedef {{}} Trade
 * @property {BigInt} amountSold
 * @property {BigInt} amountBought
 * @property {String} assetSold
 * @property {String} assetBought
 * @property {'offer'|'pool'} type
 */