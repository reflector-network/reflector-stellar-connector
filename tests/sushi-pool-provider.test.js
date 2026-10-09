/*eslint-disable no-undef */
const SushiPoolProvider = require('../src/pools/sushi/sushi-pool-provider')
const {SUSHI_FACTORY, buildGetPoolLedgerKey} = require('../src/pools/sushi/sushi-pool-helper')
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
        it('fails when no RPC connector is configured', async () => {
            await expect(provider.getTargetPools(USDC, [USDT0], NETWORK)).rejects.toThrow('SushiSwap pool provider is not configured with an RPC connector')
        })

        it('looks up factory GetPool entries for every pair, fee tier and ordering, and maps each pool to its asset', async () => {
            const rpc = {network: NETWORK, loadLedgerEntries: jest.fn().mockResolvedValue({entries: [
                {xdr: buildGetPoolEntry(SUSHI_FACTORY, USDT0_CONTRACT, USDC_CONTRACT, 500, FIXTURE_POOL)},
                {xdr: buildGetPoolEntry(SUSHI_FACTORY, USDC_CONTRACT, USDT0_CONTRACT, 500, FIXTURE_POOL)}
            ], latestLedger: 100})}
            provider.configure(rpc)
            const pools = await provider.getTargetPools(USDC, [USDT0, USDC], NETWORK)
            //USDC target skipped (same as base) - 1 pair * 4 fee tiers * 2 orderings
            expect(rpc.loadLedgerEntries).toHaveBeenCalledTimes(1)
            expect(rpc.loadLedgerEntries.mock.calls[0][0]).toHaveLength(8)
            //both orderings resolve to the same pool - listed once
            expect(pools).toEqual(new Map([[USDT0, [FIXTURE_POOL]], [USDC, []]]))
        })

        it('keeps a connector per network when the shared instance is configured for multiple data sources', async () => {
            const pubnetRpc = {network: NETWORK, loadLedgerEntries: jest.fn().mockResolvedValue({entries: [
                {xdr: buildGetPoolEntry(SUSHI_FACTORY, USDC_CONTRACT, USDT0_CONTRACT, 500, FIXTURE_POOL)}
            ], latestLedger: 100})}
            const testnetRpc = {network: 'Test SDF Network ; September 2015', loadLedgerEntries: jest.fn().mockResolvedValue({entries: [], latestLedger: 100})}
            provider.configure(pubnetRpc)
            provider.configure(testnetRpc) //must not displace the pubnet connector
            const pools = await provider.getTargetPools(USDC, [USDT0], NETWORK)
            expect(pubnetRpc.loadLedgerEntries).toHaveBeenCalledTimes(1)
            expect(testnetRpc.loadLedgerEntries).not.toHaveBeenCalled()
            expect(pools).toEqual(new Map([[USDT0, [FIXTURE_POOL]]]))
        })

        it('fails when the RPC lookup fails, so the caller cannot read it as no pools', async () => {
            const rpc = {network: NETWORK, loadLedgerEntries: jest.fn().mockRejectedValue(new Error('rpc down'))}
            provider.configure(rpc)
            await expect(provider.getTargetPools(USDC, [USDT0], NETWORK)).rejects.toThrow('rpc down')
        })

        it('looks pools up in the configured factoryContract', async () => {
            const factory = USDC_CONTRACT //any contract id serves as a stand-in factory
            const rpc = {network: NETWORK, loadLedgerEntries: jest.fn().mockResolvedValue({entries: [
                {xdr: buildGetPoolEntry(factory, USDC_CONTRACT, USDT0_CONTRACT, 500, FIXTURE_POOL)}
            ], latestLedger: 100})}
            provider.configure(rpc)
            const pools = await provider.getTargetPools(USDC, [USDT0], NETWORK, {factoryContract: factory})
            const keys = rpc.loadLedgerEntries.mock.calls[0][0]
            expect(keys).toContain(buildGetPoolLedgerKey(USDC_CONTRACT, USDT0_CONTRACT, 500, factory))
            expect(keys).not.toContain(buildGetPoolLedgerKey(USDC_CONTRACT, USDT0_CONTRACT, 500))
            expect(pools).toEqual(new Map([[USDT0, [FIXTURE_POOL]]]))
        })

        it('uses the default factory when factoryContract is unset', async () => {
            const rpc = {network: NETWORK, loadLedgerEntries: jest.fn().mockResolvedValue({entries: [], latestLedger: 100})}
            provider.configure(rpc)
            await provider.getTargetPools(USDC, [USDT0], NETWORK, {})
            const defaultKey = buildGetPoolLedgerKey(USDC_CONTRACT, USDT0_CONTRACT, 500, SUSHI_FACTORY)
            expect(rpc.loadLedgerEntries.mock.calls[0][0]).toContain(defaultKey)
        })

        it('rejects a factoryContract that is not a contract id, without a lookup', async () => {
            const rpc = {network: NETWORK, loadLedgerEntries: jest.fn()}
            provider.configure(rpc)
            await expect(provider.getTargetPools(USDC, [USDT0], NETWORK, {factoryContract: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'}))
                .rejects.toThrow('SushiSwap provider setting factoryContract must be a contract id')
            expect(rpc.loadLedgerEntries).not.toHaveBeenCalled()
        })

        //Review Focus
        it('gives an asset code it cannot encode no pool and still looks up the others', async () => {
            const rpc = {network: NETWORK, loadLedgerEntries: jest.fn().mockResolvedValue({entries: [], latestLedger: 100})}
            provider.configure(rpc)
            const pools = await provider.getTargetPools(USDC, ['INVALID', USDT0], NETWORK)
            expect(pools).toEqual(new Map([['INVALID', []], [USDT0, []]]))
            expect(rpc.loadLedgerEntries.mock.calls[0][0]).toHaveLength(8)
        })

        it('ignores a factory entry whose token pair matches no tracked asset', async () => {
            const rpc = {network: NETWORK, loadLedgerEntries: jest.fn().mockResolvedValue({entries: [
                //the fixture tokens are USDT0 and USDC themselves, so the untracked side is the pool contract id
                {xdr: buildGetPoolEntry(SUSHI_FACTORY, USDC_CONTRACT, FIXTURE_POOL, 500, FIXTURE_POOL)}
            ], latestLedger: 100})}
            provider.configure(rpc)
            expect(await provider.getTargetPools(USDC, [USDT0], NETWORK)).toEqual(new Map([[USDT0, []]]))
        })

        it('ignores a factory entry whose pair does not include the base, even when one side is tracked', async () => {
            //a USDT0 / non-base pool is not a USDC pool of USDT0, whichever side USDT0 sits on
            const otherPool = 'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA'
            const rpc = {network: NETWORK, loadLedgerEntries: jest.fn().mockResolvedValue({entries: [
                {xdr: buildGetPoolEntry(SUSHI_FACTORY, USDT0_CONTRACT, FIXTURE_POOL, 500, otherPool)},
                {xdr: buildGetPoolEntry(SUSHI_FACTORY, USDC_CONTRACT, USDT0_CONTRACT, 500, FIXTURE_POOL)}
            ], latestLedger: 100})}
            provider.configure(rpc)
            expect(await provider.getTargetPools(USDC, [USDT0], NETWORK)).toEqual(new Map([[USDT0, [FIXTURE_POOL]]]))
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
