/*eslint-disable no-undef */
const fs = require('fs')
const os = require('os')
const path = require('path')
const {Networks} = require('@stellar/stellar-sdk')
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
const {encodeAssetContractId} = require('../src/utils')
const {AQUA_API_URL} = require('../src/pools/aqua/aqua-api')

const BACKUP_URL = 'https://backup.aqua.network/p/?count=500'

const CACHE_FILENAME = 'aqua-pools.json'

const SAMPLE_POOLS = [
    {address: 'POOL_A', assets: ['TOKEN_A', 'TOKEN_B'], type: 'constant_product'},
    {address: 'POOL_B', assets: ['TOKEN_C', 'TOKEN_D'], type: 'stableswap'}
]

//the pairs the API declared for the pools of network 'net', the network the processPoolInstance tests pass
const DECLARED = new Map([['net', new Map([['POOL_B', ['TOKEN_C', 'TOKEN_D']], ['POOL_C', ['TOKEN_C', 'TOKEN_D']]])]])

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
            expect(provider.__lists.size).toBe(0)
            expect(console.warn).not.toHaveBeenCalled()
        })

        it('reads a legacy cache file (a bare array) as the list of the default URL', () => {
            fs.writeFileSync(cacheFile, JSON.stringify(SAMPLE_POOLS))
            provider.configure(cacheDir)
            expect(provider.__lists.get(AQUA_API_URL).pools).toEqual(SAMPLE_POOLS)
        })

        it('reads a single-list cache file as the list of the URL it records', () => {
            fs.writeFileSync(cacheFile, JSON.stringify({url: BACKUP_URL, pools: SAMPLE_POOLS}))
            provider.configure(cacheDir)
            expect(provider.__lists.get(BACKUP_URL).pools).toEqual(SAMPLE_POOLS)
            expect(provider.__lists.has(AQUA_API_URL)).toBe(false)
        })

        it('reads the list of every URL in a cache file, skipping an entry that is not a list', () => {
            fs.writeFileSync(cacheFile, JSON.stringify({lists: {[AQUA_API_URL]: SAMPLE_POOLS, [BACKUP_URL]: 'not a list'}}))
            provider.configure(cacheDir)
            expect(provider.__lists.get(AQUA_API_URL).pools).toEqual(SAMPLE_POOLS)
            expect(provider.__lists.has(BACKUP_URL)).toBe(false)
        })

        it('leaves lastUpdated at 0 so the next call still refreshes', () => {
            fs.writeFileSync(cacheFile, JSON.stringify(SAMPLE_POOLS))
            provider.configure(cacheDir)
            expect(provider.__lists.get(AQUA_API_URL).lastUpdated).toBe(0)
        })

        it('ignores a cache file that is neither a list, {url, pools} nor {lists}', () => {
            fs.writeFileSync(cacheFile, JSON.stringify({pools: SAMPLE_POOLS}))
            provider.configure(cacheDir)
            expect(provider.__lists.size).toBe(0)
        })

        it('warns and continues when cache file contains invalid JSON', () => {
            fs.writeFileSync(cacheFile, '{not valid json')
            provider.configure(cacheDir)
            expect(provider.__lists.size).toBe(0)
            expect(console.warn).toHaveBeenCalled()
        })
    })

    describe('__persistCache', () => {
        it('does nothing when configure has not been called', async () => {
            provider.__getList(AQUA_API_URL).pools = SAMPLE_POOLS
            await provider.__persistCache()
            expect(fs.existsSync(cacheFile)).toBe(false)
        })

        it('atomically writes the in-memory cache to disk', async () => {
            provider.configure(cacheDir)
            provider.__getList(AQUA_API_URL).pools = SAMPLE_POOLS
            await provider.__persistCache()
            const written = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
            expect(written).toEqual({lists: {[AQUA_API_URL]: SAMPLE_POOLS}})
            //tmp file should have been renamed away
            expect(fs.existsSync(cacheFile + '.tmp')).toBe(false)
        })

        it('leaves the latest lists on disk when the writes of two refreshes overlap', async () => {
            provider.configure(cacheDir)
            const writeFile = fs.promises.writeFile
            let writes = 0
            const spy = jest.spyOn(fs.promises, 'writeFile').mockImplementation(async (...args) => {
                if (writes++ === 0)
                    await new Promise(resolve => setTimeout(resolve, 50)) //the first write is slow and finishes last
                return writeFile.apply(fs.promises, args)
            })
            try {
                provider.__getList(AQUA_API_URL).pools = SAMPLE_POOLS
                const first = provider.__persistCache()
                provider.__getList(BACKUP_URL).pools = SAMPLE_POOLS //a second list refreshes meanwhile
                await Promise.all([first, provider.__persistCache()])
            } finally {
                spy.mockRestore()
            }
            expect(console.error).not.toHaveBeenCalled()
            const written = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
            expect(written).toEqual({lists: {[AQUA_API_URL]: SAMPLE_POOLS, [BACKUP_URL]: SAMPLE_POOLS}})
        })

        it('logs and swallows errors instead of throwing', async () => {
            provider.configure(cacheDir)
            provider.__getList(AQUA_API_URL).pools = SAMPLE_POOLS
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
            await provider.__maybeRefreshPools(AQUA_API_URL)
            expect(provider.__lists.get(AQUA_API_URL).pools).toEqual(SAMPLE_POOLS)
            const written = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
            expect(written).toEqual({lists: {[AQUA_API_URL]: SAMPLE_POOLS}})
        })

        it('does not write to disk when refresh fails', async () => {
            provider.configure(cacheDir)
            provider.__loadPools = jest.fn().mockRejectedValue(new Error('network down'))
            await provider.__maybeRefreshPools(AQUA_API_URL)
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
                provider.__maybeRefreshPools(AQUA_API_URL),
                provider.__maybeRefreshPools(AQUA_API_URL),
                provider.__maybeRefreshPools(AQUA_API_URL)
            ])
            expect(provider.__loadPools).toHaveBeenCalledTimes(1)
            expect(console.error).not.toHaveBeenCalled()
            const written = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
            expect(written).toEqual({lists: {[AQUA_API_URL]: SAMPLE_POOLS}})
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
            provider.__declaredTokens = DECLARED
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
            provider.__declaredTokens = DECLARED
            extractAquaPoolData.mockReturnValueOnce({reserves: [1n, 1n], tokens: ['TOKEN_C', 'TOKEN_D'], stableData})
            expect(provider.processPoolInstance('XDR', 'POOL_B', 'net', new Map(), 123, periodTimestamp)).toBeNull()
            expect(console.error).not.toHaveBeenCalled() //a shallow pool is not an error condition
        })
    })

    describe('processPoolInstance for concentrated pools', () => {
        const periodTimestamp = Math.floor(Date.now() / 1000)

        it('replaces concentrated pool reserves with min-corrected volumes', () => {
            provider.__declaredTokens = DECLARED
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
            provider.__declaredTokens = DECLARED
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
        await provider.__maybeRefreshPools(AQUA_API_URL)

        //second lifecycle: fresh instance, same cacheDir
        const restarted = new AquaPoolProvider()
        restarted.configure(cacheDir)
        expect(restarted.__lists.get(AQUA_API_URL).pools).toEqual(SAMPLE_POOLS)
    })
})

describe('AquaPoolProvider.getTargetPools', () => {
    const USDC = 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
    const AQUA = 'AQUA:GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA'
    const usdcToken = encodeAssetContractId(USDC, Networks.PUBLIC)
    const aquaToken = encodeAssetContractId(AQUA, Networks.PUBLIC)
    const xlmToken = encodeAssetContractId('XLM', Networks.PUBLIC)
    const LIST = [
        {address: 'POOL_1', assets: [usdcToken, aquaToken], type: 'constant_product'},
        {address: 'POOL_2', assets: [aquaToken, usdcToken], type: 'stableswap'},
        {address: 'POOL_3', assets: [xlmToken, aquaToken], type: 'constant_product'}
    ]
    let provider
    let cacheDir

    beforeEach(() => {
        jest.clearAllMocks()
        cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-target-pools-test-'))
        provider = new AquaPoolProvider()
        provider.configure(cacheDir)
    })

    afterEach(() => {
        fs.rmSync(cacheDir, {recursive: true, force: true})
    })

    it('returns the pools of every asset, and an empty list for an asset without pools', async () => {
        provider.__loadPools = jest.fn().mockResolvedValue(LIST)
        const pools = await provider.getTargetPools(USDC, [AQUA, 'XLM'], Networks.PUBLIC)
        expect(pools).toEqual(new Map([[AQUA, ['POOL_1', 'POOL_2']], ['XLM', []]]))
    })

    it('fails when it has no pool list', async () => {
        provider.__loadPools = jest.fn().mockRejectedValue(new Error('down'))
        await expect(provider.getTargetPools(USDC, [AQUA], Networks.PUBLIC)).rejects.toThrow('No Aqua pool list loaded from amm-api.aqua.network')
    })

    it('returns an empty list per asset on another network without aquaListUrl, without loading anything', async () => {
        provider.__loadPools = jest.fn().mockResolvedValue(LIST)
        const pools = await provider.getTargetPools(USDC, [AQUA], Networks.TESTNET)
        expect(pools).toEqual(new Map([[AQUA, []]]))
        expect(provider.__loadPools).not.toHaveBeenCalled()
    })

    it('requests the default list URL when aquaListUrl is unset', async () => {
        provider.__loadPools = jest.fn().mockResolvedValue(LIST)
        await provider.getTargetPools(USDC, [AQUA], Networks.PUBLIC, {})
        expect(provider.__loadPools).toHaveBeenCalledWith(AQUA_API_URL)
    })

    it('requests aquaListUrl exactly as given', async () => {
        provider.__loadPools = jest.fn().mockResolvedValue(LIST)
        await provider.getTargetPools(USDC, [AQUA], Networks.PUBLIC, {aquaListUrl: BACKUP_URL})
        expect(provider.__loadPools).toHaveBeenCalledWith(BACKUP_URL)
    })

    it('keeps using the stale list of the same URL when a refresh fails', async () => {
        provider.__loadPools = jest.fn().mockResolvedValueOnce(LIST).mockRejectedValue(new Error('down'))
        await provider.getTargetPools(USDC, [AQUA], Networks.PUBLIC)
        provider.__lists.get(AQUA_API_URL).lastUpdated = 0 //the next hour: a refresh is due
        const pools = await provider.getTargetPools(USDC, [AQUA], Networks.PUBLIC)
        expect(provider.__loadPools).toHaveBeenCalledTimes(2)
        expect(pools.get(AQUA)).toEqual(['POOL_1', 'POOL_2'])
    })

    it('never uses a list that came from another URL', async () => {
        provider.__loadPools = jest.fn().mockResolvedValueOnce(LIST).mockRejectedValue(new Error('down'))
        await provider.getTargetPools(USDC, [AQUA], Networks.PUBLIC)
        await expect(provider.getTargetPools(USDC, [AQUA], Networks.PUBLIC, {aquaListUrl: BACKUP_URL}))
            .rejects.toThrow('No Aqua pool list loaded from backup.aqua.network')
        expect(provider.__loadPools).toHaveBeenLastCalledWith(BACKUP_URL)
    })

    it('loads a changed aquaListUrl at once, without waiting for the hourly refresh', async () => {
        provider.__loadPools = jest.fn().mockResolvedValue(LIST)
        await provider.getTargetPools(USDC, [AQUA], Networks.PUBLIC)
        await provider.getTargetPools(USDC, [AQUA], Networks.PUBLIC, {aquaListUrl: BACKUP_URL})
        expect(provider.__loadPools.mock.calls).toEqual([[AQUA_API_URL], [BACKUP_URL]])
    })

    it('rejects an aquaListUrl that is not https, without requesting it', async () => {
        provider.__loadPools = jest.fn().mockResolvedValue(LIST)
        await expect(provider.getTargetPools(USDC, [AQUA], Networks.PUBLIC, {aquaListUrl: 'http://backup.aqua.network/p/'}))
            .rejects.toThrow('Aqua provider setting aquaListUrl must be an https URL')
        await expect(provider.getTargetPools(USDC, [AQUA], Networks.PUBLIC, {aquaListUrl: 42}))
            .rejects.toThrow('Aqua provider setting aquaListUrl must be an https URL')
        expect(provider.__loadPools).not.toHaveBeenCalled()
    })

    //Review Focus
    it('names only the host of a failing aquaListUrl', async () => {
        provider.__loadPools = jest.fn().mockRejectedValue(new Error('down'))
        const err = await provider.getTargetPools(USDC, [AQUA], Networks.PUBLIC, {aquaListUrl: 'https://backup.aqua.network/secret-key/?count=500'})
            .catch(e => e)
        expect(err.message).toBe('No Aqua pool list loaded from backup.aqua.network')
    })

    //Review Focus
    it('gives an asset code it cannot encode no pool and keeps the others', async () => {
        provider.__loadPools = jest.fn().mockResolvedValue(LIST)
        const pools = await provider.getTargetPools(USDC, ['INVALID', AQUA], Networks.PUBLIC)
        expect(pools).toEqual(new Map([['INVALID', []], [AQUA, ['POOL_1', 'POOL_2']]]))
    })
})

//one provider instance serves every data source of a node, so pubnet and testnet share it
describe('AquaPoolProvider on pubnet and testnet at once', () => {
    const TESTNET_URL = 'https://amm-api-testnet.aqua.network/pools/?size=500'
    const USDC = 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
    const AQUA = 'AQUA:GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA'
    //the same asset has a different contract id on every network
    const pubnetPair = [encodeAssetContractId(USDC, Networks.PUBLIC), encodeAssetContractId(AQUA, Networks.PUBLIC)]
    const testnetPair = [encodeAssetContractId(USDC, Networks.TESTNET), encodeAssetContractId(AQUA, Networks.TESTNET)]
    const LISTS = {
        [AQUA_API_URL]: [{address: 'PUBNET_POOL', assets: pubnetPair, type: 'constant_product'}],
        [TESTNET_URL]: [{address: 'TESTNET_POOL', assets: testnetPair, type: 'constant_product'}]
    }
    const periodTimestamp = Math.floor(Date.now() / 1000)
    let provider
    let cacheDir

    const onPubnet = target => target.getTargetPools(USDC, [AQUA], Networks.PUBLIC)
    const onTestnet = target => target.getTargetPools(USDC, [AQUA], Networks.TESTNET, {aquaListUrl: TESTNET_URL})

    beforeEach(() => {
        jest.clearAllMocks()
        cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-two-networks-test-'))
        provider = new AquaPoolProvider()
        provider.configure(cacheDir)
        provider.__loadPools = jest.fn(url => Promise.resolve(LISTS[url]))
    })

    afterEach(() => {
        fs.rmSync(cacheDir, {recursive: true, force: true})
    })

    it('finds the pools of another network in the list of its aquaListUrl', async () => {
        expect(await onTestnet(provider)).toEqual(new Map([[AQUA, ['TESTNET_POOL']]]))
        expect(provider.__loadPools).toHaveBeenCalledWith(TESTNET_URL)
    })

    it('keeps the list of each URL, without reloading either when the networks alternate', async () => {
        expect(await onPubnet(provider)).toEqual(new Map([[AQUA, ['PUBNET_POOL']]]))
        expect(await onTestnet(provider)).toEqual(new Map([[AQUA, ['TESTNET_POOL']]]))
        expect(await onPubnet(provider)).toEqual(new Map([[AQUA, ['PUBNET_POOL']]]))
        expect(await onTestnet(provider)).toEqual(new Map([[AQUA, ['TESTNET_POOL']]]))
        expect(provider.__loadPools.mock.calls).toEqual([[AQUA_API_URL], [TESTNET_URL]])
    })

    it('loads both lists when the two networks refresh at the same time', async () => {
        //every load takes a while, so the two refreshes overlap
        provider.__loadPools = jest.fn(url => new Promise(resolve => setTimeout(() => resolve(LISTS[url]), 20)))
        const [pubnet, testnet] = await Promise.all([onPubnet(provider), onTestnet(provider)])
        expect(pubnet).toEqual(new Map([[AQUA, ['PUBNET_POOL']]]))
        expect(testnet).toEqual(new Map([[AQUA, ['TESTNET_POOL']]]))
    })

    it('still loads one URL while another is in its failure cooldown', async () => {
        provider.__loadPools = jest.fn(url => url === TESTNET_URL ? Promise.reject(new Error('down')) : Promise.resolve(LISTS[url]))
        await expect(onTestnet(provider)).rejects.toThrow('No Aqua pool list loaded from amm-api-testnet.aqua.network')
        expect(await onPubnet(provider)).toEqual(new Map([[AQUA, ['PUBNET_POOL']]]))
    })

    it('checks each pool against the list of its own network', async () => {
        await onPubnet(provider)
        await onTestnet(provider)
        extractAquaPoolData.mockReturnValueOnce({reserves: [1000n, 2000n], tokens: pubnetPair})
        expect(provider.processPoolInstance('XDR', 'PUBNET_POOL', Networks.PUBLIC, new Map(), 123, periodTimestamp)?.tokens).toEqual(pubnetPair)
        extractAquaPoolData.mockReturnValueOnce({reserves: [1000n, 2000n], tokens: testnetPair})
        expect(provider.processPoolInstance('XDR', 'TESTNET_POOL', Networks.TESTNET, new Map(), 123, periodTimestamp)?.tokens).toEqual(testnetPair)
    })

    it('keeps the lists of both URLs on disk and uses them after a restart', async () => {
        await Promise.all([onPubnet(provider), onTestnet(provider)])
        const restarted = new AquaPoolProvider()
        restarted.configure(cacheDir)
        restarted.__loadPools = jest.fn().mockRejectedValue(new Error('down'))
        expect(await onPubnet(restarted)).toEqual(new Map([[AQUA, ['PUBNET_POOL']]]))
        expect(await onTestnet(restarted)).toEqual(new Map([[AQUA, ['TESTNET_POOL']]]))
    })
})
