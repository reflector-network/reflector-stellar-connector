const {Asset} = require('@stellar/stellar-sdk')
const {encodeAssetContractId} = require('../src/asset-encoder')

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