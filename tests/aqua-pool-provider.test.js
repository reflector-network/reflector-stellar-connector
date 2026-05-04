/*eslint-disable no-undef */
const fs = require('fs')
const os = require('os')
const path = require('path')
const AquaPoolProvider = require('../src/pools/aqua-pool-provider')

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
