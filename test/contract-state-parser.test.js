const { xdr } = require('stellar-base')
const {parseStateData, encodeContractId} = require('../src/contract-state-parser')

const p0 = 'AAfIhwAAAAYAAAABMC5MUHDFpc+6HXEQ48PbOL98BN2kuB5EZlyvKpAYEqQAAAAJAAABihnXh7AAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAoAAAAAAAB2PPjqvou9v42SAAkaBwAAAAA='
const p1 = 'AAfIhwAAAAYAAAABMC5MUHDFpc+6HXEQ48PbOL98BN2kuB5EZlyvKpAYEqQAAAAJAAABihnXh7AAAAAAAAAAAQAAAAEAAAAAAAAAAAAAAAoAAAAAAAAjFdIa71hyZV7aAAkaBwAAAAA='
const p2 = 'AAfIhwAAAAYAAAABMC5MUHDFpc+6HXEQ48PbOL98BN2kuB5EZlyvKpAYEqQAAAAJAAABihnXh7AAAAAAAAAAAgAAAAEAAAAAAAAAAAAAAAoAAAAAAAAHLb4QGz/dDYqOAAkaBwAAAAA='
const intitializedContractEntry = 'AA1aGwAAAAYAAAABDsOXWRmWzCuZysSw0fEPQV5zetk7vg6DolmKNC9L1SEAAAAUAAAAAQAAAAAAAAAAAAAAEwAAAAAKVF9AiieNa4GFJ3mi16q3mZrHlF3EuNtWvtjoc8/tQwAAAAEAAAALAAAADgAAAAVhZG1pbgAAAAAAABIAAAAAAAAAABwxUvNxb2R3299YHHcIknOOeHUNwWvI034of3i0z63EAAAADgAAAAZhc3NldHMAAAAAABAAAAABAAAABwAAABAAAAABAAAAAgAAAA8AAAAHU3RlbGxhcgAAAAASAAAAAfWTezJbT9Q1lF1rhtQ5jM7VuI0YQXq1NQn9mNSS04djAAAAEAAAAAEAAAACAAAADwAAAAdTdGVsbGFyAAAAABIAAAABtDQoIMWRQ4BR9l3EfiRYph2PkuFPCPSVvm6qOfktl5cAAAAQAAAAAQAAAAIAAAAPAAAAB1N0ZWxsYXIAAAAAEgAAAAHLp1JCr9Tn/M1OKJiGICOVWh0mIUCwWTW2DHUoc8fUewAAABAAAAABAAAAAgAAAA8AAAAHU3RlbGxhcgAAAAASAAAAAT6WroVffgP4c/sZVZ3AbP8F4bdlHad50UpPqvBxUUC9AAAAEAAAAAEAAAACAAAADwAAAAdTdGVsbGFyAAAAABIAAAAB+86nnJqSo+OuUmouTE/hFc0n6oz6g+TiSpmu+Qs9iS8AAAAQAAAAAQAAAAIAAAAPAAAAB1N0ZWxsYXIAAAAAEgAAAAG9t8Cc4qwH/AOYI5hhyPGm6e5+Fhn3dEbAdYLFY1fvkAAAABAAAAABAAAAAgAAAA8AAAAHU3RlbGxhcgAAAAASAAAAAbDIgZqmWfEyc3Lpew3ORJdmKFOKF+5iUDo67kF63RWlAAAADgAAAA5sYXN0X3RpbWVzdGFtcAAAAAAABQAAAYqMI1OAAAAADgAAAAZwZXJpb2QAAAAAAAUAAAAABycOAAAAABIAAAABPpauhV9+A/hz+xlVncBs/wXht2Udp3nRSk+q8HFRQL0AAAADAAAAAwAAABIAAAABsMiBmqZZ8TJzcul7Dc5El2YoU4oX7mJQOjruQXrdFaUAAAADAAAABgAAABIAAAABtDQoIMWRQ4BR9l3EfiRYph2PkuFPCPSVvm6qOfktl5cAAAADAAAAAQAAABIAAAABvbfAnOKsB/wDmCOYYcjxpunufhYZ93RGwHWCxWNX75AAAAADAAAABQAAABIAAAABy6dSQq/U5/zNTiiYhiAjlVodJiFAsFk1tgx1KHPH1HsAAAADAAAAAgAAABIAAAAB9ZN7MltP1DWUXWuG1DmMztW4jRhBerU1Cf2Y1JLTh2MAAAADAAAAAAAAABIAAAAB+86nnJqSo+OuUmouTE/hFc0n6oz6g+TiSpmu+Qs9iS8AAAADAAAABAAOq5sAAAAA'

const notInitializedContractEntry = 'AA1XIQAAAAYAAAAB0Fzfnd338nbTsNLHg5FtN0t+cUz1NEwt/5tTSIa9qeYAAAAUAAAAAQAAAAAAAAAAAAAAEwAAAAAKVF9AiieNa4GFJ3mi16q3mZrHlF3EuNtWvtjoc8/tQwAAAAAADqihAAAAAA=='

describe('parseStateData()', () => {
    test('Missing price data', () => {
        expect(() => parseStateData({prices: [p0, p2]}))
            .toThrowError('Missing price data for 1 assets')
    })
    test('Parsed price data', () => {
        expect(parseStateData({prices: [p0, p1, p2], contractEntry: intitializedContractEntry}))
            .toStrictEqual({
                admin: 'GAODCUXTOFXWI56335MBY5YISJZY46DVBXAWXSGTPYUH66FUZ6W4JNLX',
                lastTimestamp: 1694568240000n,
                prices: [558363985981014057913746n, 165685348202245997813466n, 33900364339832385538702n]
            })
    })
    test('Missing data', () => {
        expect(parseStateData({prices: [], contractEntry: null}))
            .toStrictEqual({
                admin: null,
                lastTimestamp: 0n,
                prices: [],
                uninitialized: true
            })
    })
    test('Missing init data', () => {
        expect(parseStateData({prices: [], contractEntry: notInitializedContractEntry}))
            .toStrictEqual({
                admin: null,
                lastTimestamp: 0n,
                prices: [],
                uninitialized: true
            })
    })
})

describe('encodeContractId()', () => {
    test('Contract address encoding', () => {
        expect(encodeContractId('CAYC4TCQODC2LT52DVYRBY6D3M4L67AE3WSLQHSEMZOK6KUQDAJKJMGG'))
            .toEqual('AAAAATAuTFBwxaXPuh1xEOPD2zi/fATdpLgeRGZcryqQGBKk')
    })
})