/*eslint-disable no-undef */
const {xdr} = require('@stellar/stellar-sdk')
const {xdrParseResult, processDexTrade} = require('../src/dex/meta-processor')

console.debug = jest.fn()
console.info = jest.fn()
console.warn = jest.fn()
console.error = jest.fn()
console.log = jest.fn()

function buildSuccessResultXdr() {
    return new xdr.TransactionResult({
        feeCharged: 100n,
        result: xdr.TransactionResultResult.txSuccess([]),
        ext: xdr.TransactionResultExt.v0()
    }).toXdr('base64')
}

describe('xdrParseResult', () => {
    beforeEach(() => jest.clearAllMocks())

    test('an undecodable result yields null instead of throwing', () => {
        expect(xdrParseResult({txHash: 'deadbeef', resultXdr: 'clearly-not-xdr'})).toBeNull()
        expect(console.error).toHaveBeenCalled()
        //the diagnostic must name the offending transaction - tx.hash is always undefined
        expect(console.error.mock.calls[0][0].tx).toBe('deadbeef')
    })

    test('a missing result does not throw', () => {
        expect(xdrParseResult({txHash: 'abc'})).toBeNull()
    })

    test('a decodable successful transaction still parses', () => {
        expect(xdrParseResult({txHash: 'abc', resultXdr: buildSuccessResultXdr()})).toEqual([])
    })
})

describe('processDexTrade', () => {
    beforeEach(() => jest.clearAllMocks())

    test('an unknown claim atom type is skipped instead of thrown', () => {
        const atom = {type: 'claimAtomTypeFuture', value: {amountSold: 10000000n, amountBought: 20000000n}}
        expect(processDexTrade(atom, 'abc')).toBeNull()
        expect(console.warn).toHaveBeenCalled()
    })
})
