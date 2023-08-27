const {parseStateData, encodeContractId} = require('../src/contract-state-parser')

const version = 'AAfIfQAAAAYAAAABMC5MUHDFpc+6HXEQ48PbOL98BN2kuB5EZlyvKpAYEqQAAAAOAAAADmNvbmZpZ192ZXJzaW9uAAAAAAABAAAAAAAAAAAAAAADAAAAAQAJGf0AAAAA'
const p0 = 'AAfIhwAAAAYAAAABMC5MUHDFpc+6HXEQ48PbOL98BN2kuB5EZlyvKpAYEqQAAAAJAAABihnXh7AAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAoAAAAAAAB2PPjqvou9v42SAAkaBwAAAAA='
const p1 = 'AAfIhwAAAAYAAAABMC5MUHDFpc+6HXEQ48PbOL98BN2kuB5EZlyvKpAYEqQAAAAJAAABihnXh7AAAAAAAAAAAQAAAAEAAAAAAAAAAAAAAAoAAAAAAAAjFdIa71hyZV7aAAkaBwAAAAA='
const p2 = 'AAfIhwAAAAYAAAABMC5MUHDFpc+6HXEQ48PbOL98BN2kuB5EZlyvKpAYEqQAAAAJAAABihnXh7AAAAAAAAAAAgAAAAEAAAAAAAAAAAAAAAoAAAAAAAAHLb4QGz/dDYqOAAkaBwAAAAA='
const lt = 'AAfIgQAAAAYAAAABMC5MUHDFpc+6HXEQ48PbOL98BN2kuB5EZlyvKpAYEqQAAAAOAAAADmxhc3RfdGltZXN0YW1wAAAAAAABAAAAAAAAAAAAAAAFAAABihnXh7AACRoBAAAAAA=='

describe('parseStateData()', () => {
    test('Protocol version mismatch', () => {
        expect(() => parseStateData({version}, 0))
            .toThrowError('Unsupported protocol version')
    })
    test('Missing price data', () => {
        expect(() => parseStateData({version, prices: [p0, p2]}, 1))
            .toThrowError('Missing price data for 1 assets')
    })
    test('Parsed price data', () => {
        expect(parseStateData({version, prices: [p0, p1, p2], lastTimestamp: lt}, 1))
            .toStrictEqual({
                'lastTimestamp': 1692650670000n,
                'prices': [558363985981014057913746n, 165685348202245997813466n, 33900364339832385538702n]
            })
    })
})

describe('encodeContractId()', () => {
    test('Contract address encoding', () => {
        expect(encodeContractId('CAYC4TCQODC2LT52DVYRBY6D3M4L67AE3WSLQHSEMZOK6KUQDAJKJMGG'))
            .toEqual('AAAAATAuTFBwxaXPuh1xEOPD2zi/fATdpLgeRGZcryqQGBKk')
    })
})