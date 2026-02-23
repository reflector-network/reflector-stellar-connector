/*eslint-disable no-undef */
const {Asset} = require('@stellar/stellar-sdk')
const {encodeAssetContractId, adjustPrecision} = require('../src/utils')

const futurenetPassphrase = 'Test SDF Future Network ; October 2022'

describe('encodeAssetContractId()', () => {
    test('Native token', () => {
        expect(encodeAssetContractId(Asset.native(), futurenetPassphrase))
            .toEqual('CB64D3G7SM2RTH6JSGG34DDTFTQ5CFDKVDZJZSODMCX4NJ2HV2KN7OHT')
    })
    test('AlphaNum4 token', () => {
        expect(encodeAssetContractId(new Asset('USD', 'GCP2QKBFLLEEWYVKAIXIJIJNCZ6XEBIE4PCDB6BF3GUB6FGE2RQ3HDVP'), futurenetPassphrase))
            .toEqual('CCWNZPARJG7KQ6N4BGZ5OBWKSSK4AVQ5URLDRXB4ZJXKGEJQTIIRPAHN')
    })
})

describe('adjustPrecision()', () => {
    test('Should increase precision when targetDigits is greater than digits', () => {
        const value = 123n
        const digits = 2
        const targetDigits = 5
        const result = adjustPrecision(value, digits, targetDigits)
        expect(result).toEqual(123000n)
    })

    test('Should decrease precision when targetDigits is less than digits', () => {
        const value = 123456n
        const digits = 6
        const targetDigits = 3
        const result = adjustPrecision(value, digits, targetDigits)
        expect(result).toEqual(123n) //123456 / 10^(6-3)
    })

    test('Should return the same value when targetDigits equals digits', () => {
        const value = 12345n
        const digits = 5
        const targetDigits = 5
        const result = adjustPrecision(value, digits, targetDigits)
        expect(result).toEqual(12345n)
    })

    test('Should handle value = 0n correctly', () => {
        const value = 0n
        const digits = 3
        const targetDigits = 5
        const result = adjustPrecision(value, digits, targetDigits)
        expect(result).toEqual(0n)
    })

    test('Should throw an error for invalid inputs', () => {
        expect(() => adjustPrecision('123', 2, 5)).toThrow()
        expect(() => adjustPrecision(123n, '2', 5)).toThrow()
        expect(() => adjustPrecision(123n, 2, '5')).toThrow()
    })
})