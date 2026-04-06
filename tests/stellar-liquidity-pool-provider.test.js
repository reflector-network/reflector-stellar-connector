/*eslint-disable no-undef */
const StellarLiquidityPoolProvider = require('../src/pools/stellar-liquidity-pool-provider')
const PoolType = require('../src/pools/pool-type')

describe('StellarLiquidityPoolProvider', () => {
    let provider

    beforeEach(() => {
        provider = new StellarLiquidityPoolProvider()
    })

    describe('getTargetPools', () => {
        it('should return array of pool keys for given assets', async () => {
            const baseAsset = 'XLM'
            const assets = ['USD:GCP2QKBFLLEEWYVKAIXIJIJNCZ6XEBIE4PCDB6BF3GUB6FGE2RQ3HDVP', 'EUR:GCP2QKBFLLEEWYVKAIXIJIJNCZ6XEBIE4PCDB6BF3GUB6FGE2RQ3HDVP']
            const network = 'Public Global Stellar Network ; September 2015'

            const result = await provider.getTargetPools(baseAsset, assets, network)
            expect(Array.isArray(result)).toBe(true)
            expect(result.length).toBe(2)
            result.forEach(key => {
                expect(typeof key).toBe('string')
                expect(key).toMatch(/^[A-Za-z0-9+/=]+$/)
            })
        })

        it('should filter out invalid pool keys (same assets)', async () => {
            const baseAsset = 'XLM'
            const assets = ['XLM', 'USD:GCP2QKBFLLEEWYVKAIXIJIJNCZ6XEBIE4PCDB6BF3GUB6FGE2RQ3HDVP']
            const network = 'Public Global Stellar Network ; September 2015'

            const result = await provider.getTargetPools(baseAsset, assets, network)
            expect(Array.isArray(result)).toBe(true)
            expect(result.length).toBe(1) //Only the valid pair
        })

        it('should handle errors gracefully', async () => {
            const baseAsset = 'INVALID'
            const assets = ['XLM']
            const network = 'Public Global Stellar Network ; September 2015'

            await expect(provider.getTargetPools(baseAsset, assets, network)).rejects.toThrow()
        })

        it('should return empty array for no assets', async () => {
            const baseAsset = 'XLM'
            const assets = []
            const network = 'Public Global Stellar Network ; September 2015'

            const result = await provider.getTargetPools(baseAsset, assets, network)
            expect(result).toEqual([])
        })
    })

    describe('processPoolInstance', () => {
        it('should return null for invalid pool data', () => {
            const result = provider.processPoolInstance('invalid-xdr', 'mock-contract', 'mock-network', new Map())
            expect(result).toBeNull()
        })
    })
})