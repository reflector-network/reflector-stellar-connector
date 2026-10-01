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
        it('should return array of pool keys for given assets', async () => {
            const baseAsset = 'XLM'
            const assets = ['USD:GCP2QKBFLLEEWYVKAIXIJIJNCZ6XEBIE4PCDB6BF3GUB6FGE2RQ3HDVP', 'EUR:GCP2QKBFLLEEWYVKAIXIJIJNCZ6XEBIE4PCDB6BF3GUB6FGE2RQ3HDVP']
            const network = 'Public Global Stellar Network ; September 2015'

            const result = await provider.getTargetPools(baseAsset, assets, network)
            expect(Array.isArray(result)).toBe(true)
            expect(result.length).toBe(2)
            result.forEach(key => {
                //32-byte pool id, hex encoded from the hash view itself
                expect(key).toMatch(/^[0-9a-f]{64}$/)
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

        it('skips an unparseable asset and keeps the pools that resolved', async () => {
            const baseAsset = 'XLM'
            const assets = ['INVALID', 'USD:GCP2QKBFLLEEWYVKAIXIJIJNCZ6XEBIE4PCDB6BF3GUB6FGE2RQ3HDVP']
            const network = 'Public Global Stellar Network ; September 2015'

            const result = await provider.getTargetPools(baseAsset, assets, network)
            expect(result).toHaveLength(1)
            expect(console.warn).toHaveBeenCalled()
        })

        it('skips an alias of the base asset without dropping the rest', async () => {
            const baseAsset = 'XLM'
            //'native' parses to the same asset as 'XLM', so getLiquidityPoolId rejects the pair as unordered
            const assets = ['native', 'USD:GCP2QKBFLLEEWYVKAIXIJIJNCZ6XEBIE4PCDB6BF3GUB6FGE2RQ3HDVP']
            const network = 'Public Global Stellar Network ; September 2015'

            const result = await provider.getTargetPools(baseAsset, assets, network)
            expect(result).toHaveLength(1)
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