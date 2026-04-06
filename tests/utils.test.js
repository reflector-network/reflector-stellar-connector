/*eslint-disable no-undef */
const {encodeAssetContractId, adjustPrecision} = require('../src/utils')

const futurenetPassphrase = 'Test SDF Future Network ; October 2022'

describe('encodeAssetContractId()', () => {
    it('should encode native token', () => {
        expect(encodeAssetContractId('XLM', futurenetPassphrase))
            .toEqual('CB64D3G7SM2RTH6JSGG34DDTFTQ5CFDKVDZJZSODMCX4NJ2HV2KN7OHT')
    })
    it('should encode AlphaNum4 token', () => {
        expect(encodeAssetContractId('USD:GCP2QKBFLLEEWYVKAIXIJIJNCZ6XEBIE4PCDB6BF3GUB6FGE2RQ3HDVP', futurenetPassphrase))
            .toEqual('CCWNZPARJG7KQ6N4BGZ5OBWKSSK4AVQ5URLDRXB4ZJXKGEJQTIIRPAHN')
    })
    it('should encode AlphaNum12 token', () => {
        expect(encodeAssetContractId('LONGTOKNCODe:GCP2QKBFLLEEWYVKAIXIJIJNCZ6XEBIE4PCDB6BF3GUB6FGE2RQ3HDVP', futurenetPassphrase))
            .toEqual('CCVVR4Z6CFSG5P5UKHBIEDJQAXOF3C6NZQIQRS2ONQWK2PPRBB5V32LK')
    })
    it('should throw an error for invalid asset string', () => {
        expect(() => encodeAssetContractId('INVALIDASSET', futurenetPassphrase)).toThrow()
    })
    it('should encode contract ID as asset', () => {
        expect(encodeAssetContractId('CCWNZPARJG7KQ6N4BGZ5OBWKSSK4AVQ5URLDRXB4ZJXKGEJQTIIRPAHN', futurenetPassphrase))
            .toEqual('CCWNZPARJG7KQ6N4BGZ5OBWKSSK4AVQ5URLDRXB4ZJXKGEJQTIIRPAHN')
    })
})

describe('adjustPrecision()', () => {
    it('should increase precision when targetDigits is greater than digits', () => {
        const value = 123n
        const digits = 2
        const targetDigits = 5
        const result = adjustPrecision(value, digits, targetDigits)
        expect(result).toEqual(123000n)
    })

    it('should decrease precision when targetDigits is less than digits', () => {
        const value = 123456n
        const digits = 6
        const targetDigits = 3
        const result = adjustPrecision(value, digits, targetDigits)
        expect(result).toEqual(123n) //123456 / 10^(6-3)
    })

    it('should return the same value when targetDigits equals digits', () => {
        const value = 12345n
        const digits = 5
        const targetDigits = 5
        const result = adjustPrecision(value, digits, targetDigits)
        expect(result).toEqual(12345n)
    })

    it('should handle value = 0n correctly', () => {
        const value = 0n
        const digits = 3
        const targetDigits = 5
        const result = adjustPrecision(value, digits, targetDigits)
        expect(result).toEqual(0n)
    })

    it('should handle large diff without precision loss', () => {
        // 10 ** 20 loses precision as Number (becomes 100000000000000000000 but floating point)
        // BigInt exponentiation should be exact
        const value = 1n
        const result = adjustPrecision(value, 0, 20)
        expect(result).toEqual(100000000000000000000n)
    })

    it('should handle large downscale without precision loss', () => {
        const value = 123456789012345678901234n
        const result = adjustPrecision(value, 24, 4)
        expect(result).toEqual(1234n)
    })

    it('should handle diff beyond safe integer exponent range', () => {
        // 10 ** 18 as Number is 1000000000000000000 but 10 ** 19 starts losing precision
        const value = 7n
        const result = adjustPrecision(value, 0, 19)
        expect(result).toEqual(70000000000000000000n)
    })

    it('should throw an error for invalid inputs', () => {
        expect(() => adjustPrecision('123', 2, 5)).toThrow()
        expect(() => adjustPrecision(123n, '2', 5)).toThrow()
        expect(() => adjustPrecision(123n, 2, '5')).toThrow()
    })
})