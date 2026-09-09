/*eslint-disable no-undef */
const SushiPoolProvider = require('../src/pools/sushi/sushi-pool-provider')
const {SUSHI_FACTORY} = require('../src/pools/sushi/sushi-pool-helper')
const PoolType = require('../src/pools/pool-type')
const {buildSushiPoolInstance, buildGetPoolEntry, FIXTURE_POOL, FIXTURE_TOKEN0, FIXTURE_TOKEN1} = require('./helpers/sushi-fixture')

console.warn = jest.fn()
console.error = jest.fn()
console.debug = jest.fn()

const NETWORK = 'Public Global Stellar Network ; September 2015'
//wrapped classic asset contract ids on pubnet
const USDC = 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
const USDC_CONTRACT = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75'
const USDT0 = 'USDT0:GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q'
const USDT0_CONTRACT = 'CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF'

describe('SushiPoolProvider', () => {
    let provider

    beforeEach(() => {
        jest.clearAllMocks()
        provider = new SushiPoolProvider()
    })

    it('exposes the SUSHISWAP pool type', () => {
        expect(provider.type).toBe(PoolType.SUSHISWAP)
    })

    describe('getTargetPools', () => {
        it('returns empty list when no RPC connector is configured', async () => {
            expect(await provider.getTargetPools(USDC, [USDT0], NETWORK)).toEqual([])
        })

        it('looks up factory GetPool entries for every pair, fee tier and ordering, deduping by pool', async () => {
            const rpc = {loadLedgerEntries: jest.fn().mockResolvedValue([
                {xdr: buildGetPoolEntry(SUSHI_FACTORY, USDT0_CONTRACT, USDC_CONTRACT, 500, FIXTURE_POOL)},
                {xdr: buildGetPoolEntry(SUSHI_FACTORY, USDC_CONTRACT, USDT0_CONTRACT, 500, FIXTURE_POOL)}
            ])}
            provider.configure(rpc)
            const pools = await provider.getTargetPools(USDC, [USDT0, USDC], NETWORK)
            //USDC target skipped (same as base) - 1 pair * 4 fee tiers * 2 orderings
            expect(rpc.loadLedgerEntries).toHaveBeenCalledTimes(1)
            expect(rpc.loadLedgerEntries.mock.calls[0][0]).toHaveLength(8)
            //both orderings resolve to the same pool - deduped
            expect(pools).toEqual([FIXTURE_POOL])
        })

        it('returns empty list when the RPC lookup fails', async () => {
            const rpc = {loadLedgerEntries: jest.fn().mockRejectedValue(new Error('rpc down'))}
            provider.configure(rpc)
            expect(await provider.getTargetPools(USDC, [USDT0], NETWORK)).toEqual([])
        })
    })

    describe('processPoolInstance', () => {
        it('produces min-corrected volumes from the pool instance', () => {
            //fixture: price 4.0 token1 per token0, balances 50.0 / 100.0 - token0 side is worth 200, so token1 caps
            const result = provider.processPoolInstance(buildSushiPoolInstance(), FIXTURE_POOL, NETWORK, new Map(), 123)
            expect(result.tokens).toEqual([FIXTURE_TOKEN0, FIXTURE_TOKEN1])
            expect(result.reserves).toEqual([2500000000000000n, 10000000000000000n]) //[100.0 / 4.0, 100.0] at 14 decimals
        })

        it('skips pools with uninitialized price', () => {
            const instance = buildSushiPoolInstance({sqrtPriceX96: 0n})
            expect(provider.processPoolInstance(instance, FIXTURE_POOL, NETWORK, new Map(), 123)).toBeNull()
            expect(console.error).not.toHaveBeenCalled()
        })

        it('skips pools when token metadata failed to load', () => {
            const meta = new Map([
                [FIXTURE_TOKEN0, {failedAt: Date.now()}],
                [FIXTURE_TOKEN1, {decimals: 7}]
            ])
            expect(provider.processPoolInstance(buildSushiPoolInstance(), FIXTURE_POOL, NETWORK, meta, 123)).toBeNull()
            expect(console.error).not.toHaveBeenCalled() //a failed meta load is not an error condition here
        })

        it('skips pools with empty balances', () => {
            const instance = buildSushiPoolInstance({balance0: 0n})
            expect(provider.processPoolInstance(instance, FIXTURE_POOL, NETWORK, new Map(), 123)).toBeNull()
            expect(console.error).not.toHaveBeenCalled()
        })
    })
})
