/*eslint-disable no-undef */
const StellarLiquidityPoolProvider = require('../src/pools/stellar/stellar-liquidity-pool-provider')
const PoolType = require('../src/pools/pool-type')

//mock console
console.debug = jest.fn()
console.info = jest.fn()
console.warn = jest.fn()
console.error = jest.fn()
console.log = jest.fn()

describe('StellarLiquidityPoolProvider', () => {
    let provider

    beforeEach(() => {
        provider = new StellarLiquidityPoolProvider()
    })

    describe('getTargetPools', () => {
        const network = 'Public Global Stellar Network ; September 2015'
        const USD = 'USD:GCP2QKBFLLEEWYVKAIXIJIJNCZ6XEBIE4PCDB6BF3GUB6FGE2RQ3HDVP'
        const EUR = 'EUR:GCP2QKBFLLEEWYVKAIXIJIJNCZ6XEBIE4PCDB6BF3GUB6FGE2RQ3HDVP'

        it('returns the pool key of every asset', async () => {
            const result = await provider.getTargetPools('XLM', [USD, EUR], network)
            expect([...result.keys()]).toEqual([USD, EUR])
            for (const pools of result.values()) {
                expect(pools).toHaveLength(1)
                //32-byte pool id, hex encoded from the hash view itself
                expect(pools[0]).toMatch(/^[0-9a-f]{64}$/)
            }
        })

        it('gives an asset equal to the base no pool', async () => {
            const result = await provider.getTargetPools('XLM', ['XLM', USD], network)
            expect(result.get('XLM')).toEqual([])
            expect(result.get(USD)).toHaveLength(1)
        })

        it('gives an unparseable asset no pool and keeps the others', async () => {
            const result = await provider.getTargetPools('XLM', ['INVALID', USD], network)
            expect(result.get('INVALID')).toEqual([])
            expect(result.get(USD)).toHaveLength(1)
            expect(console.warn).toHaveBeenCalled()
        })

        it('gives an alias of the base asset no pool without dropping the rest', async () => {
            //'native' parses to the same asset as 'XLM', so getLiquidityPoolId rejects the pair as unordered
            const result = await provider.getTargetPools('XLM', ['native', USD], network)
            expect(result.get('native')).toEqual([])
            expect(result.get(USD)).toHaveLength(1)
        })

        it('returns an empty map for no assets', async () => {
            expect(await provider.getTargetPools('XLM', [], network)).toEqual(new Map())
        })
    })

    describe('processPoolInstance', () => {
        it('should return null for invalid pool data', () => {
            const result = provider.processPoolInstance('invalid-xdr', 'mock-contract', 'mock-network', new Map())
            expect(result).toBeNull()
        })
    })
})