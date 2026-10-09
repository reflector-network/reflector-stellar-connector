/*eslint-disable no-undef */
const {xdr, scValToNative, Address} = require('@stellar/stellar-sdk')
const {extractSushiPoolData, buildGetPoolLedgerKey, SUSHI_FACTORY} = require('../src/pools/sushi/sushi-pool-helper')
const {buildSushiPoolInstance, FIXTURE_TOKEN0, FIXTURE_TOKEN1} = require('./helpers/sushi-fixture')

const defaultMeta = new Map([
    [FIXTURE_TOKEN0, {decimals: 7}],
    [FIXTURE_TOKEN1, {decimals: 7}]
])

describe('extractSushiPoolData', () => {
    it('extracts tokens, reserves and concentrated data from a pool instance', () => {
        const poolData = extractSushiPoolData(buildSushiPoolInstance(), defaultMeta)
        expect(poolData.tokens).toEqual([FIXTURE_TOKEN0, FIXTURE_TOKEN1])
        expect(poolData.reserves).toEqual([5000000000000000n, 10000000000000000n]) //50.0 / 100.0 at 14 decimals
        expect(poolData.concentratedData).toEqual({sqrtPriceX96: 2n ** 97n, digits: [7, 7]})
    })

    it('applies per-token decimals from token metadata', () => {
        const meta = new Map([
            [FIXTURE_TOKEN0, {decimals: 7}],
            [FIXTURE_TOKEN1, {decimals: 8}]
        ])
        const poolData = extractSushiPoolData(buildSushiPoolInstance(), meta)
        expect(poolData.reserves).toEqual([5000000000000000n, 1000000000000000n]) //balance1 raw is 8-decimals now
        expect(poolData.concentratedData.digits).toEqual([7, 8])
    })

    it('returns null when token metadata failed to load', () => {
        //updateTokenMeta stores {failedAt} without decimals when the on-chain decimals() call fails
        const meta = new Map([
            [FIXTURE_TOKEN0, {decimals: 7}],
            [FIXTURE_TOKEN1, {failedAt: Date.now()}]
        ])
        expect(extractSushiPoolData(buildSushiPoolInstance(), meta)).toBeNull()
    })

    it('returns null for a non-SushiSwap instance', () => {
        const aquaFixture = require('./fixtures/concentrated-pool-instance.json')
        expect(extractSushiPoolData(aquaFixture.xdr, defaultMeta)).toBeNull()
    })
})

describe('buildGetPoolLedgerKey', () => {
    it('builds a persistent factory GetPool contract data key', () => {
        const key = xdr.LedgerKey.fromXdr(buildGetPoolLedgerKey(FIXTURE_TOKEN0, FIXTURE_TOKEN1, 3000), 'base64')
        const data = key.value
        expect(data.durability.name).toBe('persistent')
        expect(scValToNative(data.key)).toEqual(['GetPool', FIXTURE_TOKEN0, FIXTURE_TOKEN1, 3000])
    })

    it('builds the key under the factory it is given', () => {
        const key = xdr.LedgerKey.fromXdr(buildGetPoolLedgerKey(FIXTURE_TOKEN0, FIXTURE_TOKEN1, 3000, FIXTURE_TOKEN0), 'base64')
        expect(Address.fromScAddress(key.value.contract).toString()).toBe(FIXTURE_TOKEN0)
    })

    it('targets the SushiSwap factory contract', () => {
        expect(SUSHI_FACTORY).toBe('CD3KRKGDRVWPXVB3VXLUMQKMX6XZ6Q2H334IVZD4XXNAMKSRVQL5GLYF')
    })
})
