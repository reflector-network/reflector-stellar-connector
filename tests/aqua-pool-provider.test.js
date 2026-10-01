/*eslint-disable no-undef */
const fs = require('fs')
const os = require('os')
const path = require('path')
const AquaPoolProvider = require('../src/pools/aqua/aqua-pool-provider')

jest.mock('../src/pools/aqua/aqua-pool-helper', () => {
    const actual = jest.requireActual('../src/pools/aqua/aqua-pool-helper')
    return {
        ...actual,
        extractAquaPoolData: jest.fn(actual.extractAquaPoolData) //mock only the XDR boundary, keep price math real
    }
})
const {extractAquaPoolData, calculatePrice} = require('../src/pools/aqua/aqua-pool-helper')
const {calculatePoolVolumes, calculateConcentratedPrice} = require('../src/pools/utils')

const CACHE_FILENAME = 'aqua-pools.json'

const SAMPLE_POOLS = [
    {address: 'POOL_A', assets: ['TOKEN_A', 'TOKEN_B'], type: 'constant_product'},
    {address: 'POOL_B', assets: ['TOKEN_C', 'TOKEN_D'], type: 'stableswap'}
]

console.warn = jest.fn()
console.error = jest.fn()
console.debug = jest.fn()
console.log = jest.fn()

describe('AquaPoolProvider on-disk cache', () => {
    let provider
    let cacheDir
    let cacheFile

    beforeEach(() => {
        jest.clearAllMocks()
        cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-pool-provider-test-'))
        cacheFile = path.join(cacheDir, CACHE_FILENAME)
        provider = new AquaPoolProvider()
    })

    afterEach(() => {
        fs.rmSync(cacheDir, {recursive: true, force: true})
    })

    describe('configure', () => {
        it('sets cache file path even when no snapshot exists', () => {
            provider.configure(cacheDir)
            expect(provider.__cached).toBeNull()
            expect(console.warn).not.toHaveBeenCalled()
        })

        it('loads existing cache snapshot from disk', () => {
            fs.writeFileSync(cacheFile, JSON.stringify(SAMPLE_POOLS))
            provider.configure(cacheDir)
            expect(provider.__cached).toEqual(SAMPLE_POOLS)
        })

        it('leaves __lastUpdated at 0 so the next call still refreshes', () => {
            fs.writeFileSync(cacheFile, JSON.stringify(SAMPLE_POOLS))
            provider.configure(cacheDir)
            expect(provider.__lastUpdated).toBe(0)
        })

        it('ignores cache file when JSON content is not an array', () => {
            fs.writeFileSync(cacheFile, JSON.stringify({pools: SAMPLE_POOLS}))
            provider.configure(cacheDir)
            expect(provider.__cached).toBeNull()
        })

        it('warns and continues when cache file contains invalid JSON', () => {
            fs.writeFileSync(cacheFile, '{not valid json')
            provider.configure(cacheDir)
            expect(provider.__cached).toBeNull()
            expect(console.warn).toHaveBeenCalled()
        })
    })

    describe('__persistCache', () => {
        it('does nothing when configure has not been called', async () => {
            provider.__cached = SAMPLE_POOLS
            await provider.__persistCache()
            expect(fs.existsSync(cacheFile)).toBe(false)
        })

        it('atomically writes the in-memory cache to disk', async () => {
            provider.configure(cacheDir)
            provider.__cached = SAMPLE_POOLS
            await provider.__persistCache()
            const written = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
            expect(written).toEqual(SAMPLE_POOLS)
            //tmp file should have been renamed away
            expect(fs.existsSync(cacheFile + '.tmp')).toBe(false)
        })

        it('logs and swallows errors instead of throwing', async () => {
            provider.configure(cacheDir)
            provider.__cached = SAMPLE_POOLS
            //point cache file at a path inside a non-existent directory to force a write error
            provider.__cacheFile = path.join(cacheDir, 'missing-subdir', CACHE_FILENAME)
            await expect(provider.__persistCache()).resolves.toBeUndefined()
            expect(console.error).toHaveBeenCalled()
        })
    })

    describe('__maybeRefreshPools persistence', () => {
        it('writes the loaded pool list to disk after a successful refresh', async () => {
            provider.configure(cacheDir)
            provider.__loadPools = jest.fn().mockResolvedValue(SAMPLE_POOLS)
            await provider.__maybeRefreshPools()
            expect(provider.__cached).toEqual(SAMPLE_POOLS)
            const written = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
            expect(written).toEqual(SAMPLE_POOLS)
        })

        it('does not write to disk when refresh fails', async () => {
            provider.configure(cacheDir)
            provider.__loadPools = jest.fn().mockRejectedValue(new Error('network down'))
            await provider.__maybeRefreshPools()
            expect(fs.existsSync(cacheFile)).toBe(false)
            expect(console.error).toHaveBeenCalled()
        })

        it('runs a single refresh for concurrent callers without tmp-file rename races', async () => {
            provider.configure(cacheDir)
            provider.__loadPools = jest.fn().mockImplementation(async () => {
                await new Promise(resolve => setTimeout(resolve, 50)) //keep the refresh in-flight so callers overlap
                return SAMPLE_POOLS
            })
            await Promise.all([
                provider.__maybeRefreshPools(),
                provider.__maybeRefreshPools(),
                provider.__maybeRefreshPools()
            ])
            expect(provider.__loadPools).toHaveBeenCalledTimes(1)
            expect(console.error).not.toHaveBeenCalled()
            const written = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
            expect(written).toEqual(SAMPLE_POOLS)
        })
    })

    describe('processPoolInstance for stable pools', () => {
        //constant amplification (initialA === futureA, ramp finished in the past), no fee
        const pastTimestamp = BigInt(Math.floor(Date.now() / 1000) - 3600)
        const stableData = {
            initialA: 100n,
            initialATime: pastTimestamp - 7200n,
            futureA: 100n,
            futureATime: pastTimestamp,
            fee: 0n
        }
        const periodTimestamp = Math.floor(Date.now() / 1000)

        it('replaces stable pool reserves with min-corrected volumes', () => {
            provider.__declaredTokens = new Map([['POOL_B', ['TOKEN_C', 'TOKEN_D']], ['POOL_C', ['TOKEN_C', 'TOKEN_D']]])
            const reserves = [3083627186900000000n, 4000679061030000000n]
            extractAquaPoolData.mockReturnValueOnce({reserves: [...reserves], tokens: ['TOKEN_C', 'TOKEN_D'], stableData})
            const result = provider.processPoolInstance('XDR', 'POOL_B', 'net', new Map(), 123, periodTimestamp)
            expect(result.reserves).toEqual(calculatePoolVolumes(reserves, calculatePrice(reserves, stableData, periodTimestamp)))
            //token0 is the scarcer side - kept as-is, with its stable-price value in the token1 slot
            expect(result.reserves[0]).toBe(reserves[0])
            expect(result.reserves[1]).toBeGreaterThan(reserves[0])
            expect(result.reserves[1]).toBeLessThan(reserves[1])
            expect(result.tokens).toEqual(['TOKEN_C', 'TOKEN_D'])
        })

        it('skips stable pools too shallow to price', () => {
            provider.__declaredTokens = new Map([['POOL_B', ['TOKEN_C', 'TOKEN_D']], ['POOL_C', ['TOKEN_C', 'TOKEN_D']]])
            extractAquaPoolData.mockReturnValueOnce({reserves: [1n, 1n], tokens: ['TOKEN_C', 'TOKEN_D'], stableData})
            expect(provider.processPoolInstance('XDR', 'POOL_B', 'net', new Map(), 123, periodTimestamp)).toBeNull()
            expect(console.error).not.toHaveBeenCalled() //a shallow pool is not an error condition
        })
    })

    describe('processPoolInstance for concentrated pools', () => {
        const periodTimestamp = Math.floor(Date.now() / 1000)

        it('replaces concentrated pool reserves with min-corrected volumes', () => {
            provider.__declaredTokens = new Map([['POOL_B', ['TOKEN_C', 'TOKEN_D']], ['POOL_C', ['TOKEN_C', 'TOKEN_D']]])
            const reserves = [3398582110570000000n, 3710021060590000000n]
            const concentratedData = {sqrtPriceX96: 79246271960821347022979480869n, digits: [7, 7]}
            extractAquaPoolData.mockReturnValueOnce({reserves: [...reserves], tokens: ['TOKEN_C', 'TOKEN_D'], concentratedData})
            const result = provider.processPoolInstance('XDR', 'POOL_C', 'net', new Map(), 123, periodTimestamp)
            expect(result.reserves).toEqual(calculatePoolVolumes(reserves, calculateConcentratedPrice(concentratedData)))
            //price > 1, so the token0 side is the scarcer one - kept as-is
            expect(result.reserves[0]).toBe(reserves[0])
            expect(result.tokens).toEqual(['TOKEN_C', 'TOKEN_D'])
        })

        it('skips concentrated pools with uninitialized price', () => {
            provider.__declaredTokens = new Map([['POOL_B', ['TOKEN_C', 'TOKEN_D']], ['POOL_C', ['TOKEN_C', 'TOKEN_D']]])
            const concentratedData = {sqrtPriceX96: 0n, digits: [7, 7]}
            extractAquaPoolData.mockReturnValueOnce({reserves: [1000000000000000000n, 1000000000000000000n], tokens: ['TOKEN_C', 'TOKEN_D'], concentratedData})
            expect(provider.processPoolInstance('XDR', 'POOL_C', 'net', new Map(), 123, periodTimestamp)).toBeNull()
            expect(console.error).not.toHaveBeenCalled()
        })
    })

    it('survives a "restart" by reusing a previously persisted snapshot', async () => {
        //first lifecycle: load from API and persist
        provider.configure(cacheDir)
        provider.__loadPools = jest.fn().mockResolvedValue(SAMPLE_POOLS)
        await provider.__maybeRefreshPools()

        //second lifecycle: fresh instance, same cacheDir
        const restarted = new AquaPoolProvider()
        restarted.configure(cacheDir)
        expect(restarted.__cached).toEqual(SAMPLE_POOLS)
    })
})
