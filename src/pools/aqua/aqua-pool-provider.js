/*eslint-disable class-methods-use-this */
const fs = require('fs')
const path = require('path')
const {Networks} = require('@stellar/stellar-sdk')
const {encodeAssetContractId, normalizeTimestamp} = require('../../utils')
const {calculateConcentratedPrice, calculatePoolVolumes} = require('../utils')
const PoolProviderBase = require('../pool-provider-base')
const PoolType = require('../pool-type')
const {loadAquaPools, AQUA_API_URL} = require('./aqua-api')
const {extractAquaPoolData, calculatePrice} = require('./aqua-pool-helper')

const AQUA_FAILURE_COOLDOWN_MS = 5 * 60 * 1000
const AQUA_CACHE_FILENAME = 'aqua-pools.json'

/**
 * @param {string} [value] - the data source's aquaListUrl
 * @return {string} the pool list URL to request, exactly as given; the default when unset
 */
function resolveListUrl(value) {
    if (value === undefined || value === null)
        return AQUA_API_URL
    let url = null
    if (typeof value === 'string') {
        try {
            url = new URL(value)
        } catch (err) {
            url = null
        }
    }
    if (!url || url.protocol !== 'https:')
        throw new Error('Aqua provider setting aquaListUrl must be an https URL')
    return value
}

class AquaPoolProvider extends PoolProviderBase {

    __lastUpdated = 0

    __failedAt = 0

    /**
     * @type {{address: string, type: string, assets: string}[]}
     * @private
     */
    __cached = null

    /**
     * The URL __cached was loaded from: a list from another URL describes another index and is never used
     * @type {string|null}
     * @private
     */
    __listUrl = null

    /**
     * The URL the refresh schedule and failure cooldown belong to
     * @type {string|null}
     * @private
     */
    __refreshUrl = null

    /**
     * Token pair the API claimed for each pool address, checked against the pool's own storage before use
     * @type {Map<string, string[]>}
     * @private
     */
    __declaredTokens = new Map()

    /**
     * @type {string|null}
     * @private
     */
    __cacheFile = null

    /**
     * In-flight refresh shared by concurrent callers to prevent duplicate loads and cache persistence races
     * @type {Promise|null}
     * @private
     */
    __refreshPromise = null

    /**
     * Configure on-disk cache location and load any existing snapshot.
     * @param {string} cacheDir - directory where the cache file is stored
     */
    configure(cacheDir) {
        this.__cacheFile = path.join(cacheDir, AQUA_CACHE_FILENAME)
        try {
            const raw = fs.readFileSync(this.__cacheFile, 'utf8')
            const parsed = JSON.parse(raw)
            if (Array.isArray(parsed)) {
                //written before the list URL was configurable: it came from the default URL
                this.__cached = parsed
                this.__listUrl = AQUA_API_URL
            } else if (parsed && typeof parsed.url === 'string' && Array.isArray(parsed.pools)) {
                this.__cached = parsed.pools
                this.__listUrl = parsed.url
            }
        } catch (err) {
            if (err.code !== 'ENOENT') {
                console.warn({msg: 'Failed to load Aqua pool cache from disk', file: this.__cacheFile, err})
            }
        }
    }

    async __persistCache() {
        if (!this.__cacheFile)
            return
        const tmpFile = this.__cacheFile + '.tmp'
        try {
            await fs.promises.writeFile(tmpFile, JSON.stringify({url: this.__listUrl, pools: this.__cached}))
            await fs.promises.rename(tmpFile, this.__cacheFile)
        } catch (err) {
            console.error({msg: 'Failed to persist Aqua pool cache to disk', file: this.__cacheFile, err})
        }
    }

    /**
     * Load the pool list from an Aqua API URL with its request limits applied
     * @param {string} url - the first page of the pool list
     * @returns {Promise<{address: string, assets: string[], type: string}[]>}
     */
    async __loadPools(url) {
        return await loadAquaPools({baseUrl: url})
    }

    async __maybeRefreshPools(url) {
        if (this.__refreshPromise) { //refresh already in progress - wait for it instead of starting another one
            await this.__refreshPromise
            return
        }
        //the hourly schedule and the failure cooldown belong to one list URL: a new URL is loaded at once
        if (url !== this.__refreshUrl) {
            this.__refreshUrl = url
            this.__lastUpdated = 0
            this.__failedAt = 0
        }
        const now = Date.now()
        const trimmedTs = normalizeTimestamp(now, 60 * 60 * 1000) //trim to hours in order to refresh every 60 minutes
        if (trimmedTs <= this.__lastUpdated)
            return
        if (this.__failedAt && now - this.__failedAt < AQUA_FAILURE_COOLDOWN_MS) {
            //within failure cooldown - keep stale cache
            console.warn({msg: 'Aqua pool refresh in cooldown - using stale pool list', failedAt: this.__failedAt, retryAfter: this.__failedAt + AQUA_FAILURE_COOLDOWN_MS})
            return
        }
        this.__refreshPromise = (async () => {
            try {
                this.__cached = await this.__loadPools(url)
                this.__listUrl = url
                this.__lastUpdated = trimmedTs
                this.__failedAt = 0
                await this.__persistCache()
            } catch (err) {
                this.__failedAt = now
                console.error({msg: `Error loading pool list for ${this.constructor.name} provider`, err})
            } finally {
                this.__refreshPromise = null
            }
        })()
        await this.__refreshPromise
    }

    /**
     * Get pool type
     * @return {string}
     */
    get type() {
        return PoolType.AQUA
    }

    /**
     * Aqua pools pairing the base asset with each tracked asset, from the cached pool list
     * @param {string} baseAsset - oracle base token
     * @param {string[]} assets - tracked assets
     * @param {string} network - network passphrase
     * @param {{aquaListUrl: string}} [settings] - provider settings from the data source; unset means the default URL
     * @return {Promise<Map<string, string[]>>} pool addresses per asset; rejects when there is no pool list
     */
    async getTargetPools(baseAsset, assets, network, settings = {}) {
        const result = new Map(assets.map(asset => [asset, []]))
        //the Aqua API indexes pubnet only; matching its addresses on another network compares unrelated contract ids
        if (network !== Networks.PUBLIC) {
            console.debug({msg: 'Aqua pool provider serves pubnet only', network})
            return result
        }
        const url = resolveListUrl(settings.aquaListUrl)
        await this.__maybeRefreshPools(url)
        const data = this.__cached
        //without a list from this URL the provider has not answered, and must not read as "no pools"; the host
        //alone is named, because a list URL can carry a key in its path or query
        if (!data || this.__listUrl !== url)
            throw new Error(`No Aqua pool list loaded from ${new URL(url).host}`)
        //remember what the API claims each pool holds, so the on-chain instance can be checked against it
        this.__declaredTokens = new Map(data.map(pool => [pool.address, [...pool.assets].sort()]))
        const baseToken = encodeAssetContractId(baseAsset, network)
        const assetsByToken = new Map()
        for (const asset of assets) {
            try {
                assetsByToken.set(encodeAssetContractId(asset, network), asset)
            } catch (err) {
                //an asset with no contract id has no Aqua pool, and must not fail the others
                console.warn({msg: 'Skipping Aqua pair', baseAsset, asset, network, err: err.message})
            }
        }
        for (const pool of data) {
            if (!pool.type //check if pool has type
                || !pool.assets //check if pool has assets
                || pool.assets.length !== 2 //check for 2 assets
                || new Set(pool.assets).size !== 2 //check for duplicates
            ) {
                console.warn({msg: 'Skipping pool with invalid data', poolId: pool.address, type: pool.type, assets: pool.assets})
                continue
            }
            if (!pool.assets.includes(baseToken))
                continue
            const asset = assetsByToken.get(pool.assets.find(a => a !== baseToken))
            if (asset)
                result.get(asset).push(pool.address)
        }
        console.debug({msg: 'Pools found', baseAsset: baseToken, pools: Object.fromEntries(result)})
        return result
    }

    /**
     * @param {string} poolInstance - pool data instance in XDR format
     * @param {string} contractId - pool contract id
     * @param {string} network - network passphrase
     * @param {Map<string, {decimals: number}>} tokenMeta - Metadata for tokens to aggregate pools data for
     * @param {number} lastModifiedLedger - pool's last-modified ledger seq
     * @param {number} periodTimestamp - period the snapshot is priced for, in seconds
     * @return {{reserves: BigInt[], tokens: string[]}|null} - pool reserves and tokens or null if the pool is invalid
     */
    processPoolInstance(poolInstance, contractId, network, tokenMeta, lastModifiedLedger, periodTimestamp) {
        try {
            //extract pool data
            const poolData = extractAquaPoolData(poolInstance, tokenMeta)

            //skip if pool is invalid
            if (!poolData || poolData.reserves.some(r => r <= 0n)) {
                console.debug({msg: 'Skipping invalid pool', poolId: contractId, lastModifiedLedger})
                return null
            }
            //the API named this pool's pair; the contract must agree before its reserves are priced
            const declared = this.__declaredTokens.get(contractId)
            const onChain = [...poolData.tokens].sort()
            if (!declared || declared.length !== 2 || onChain[0] !== declared[0] || onChain[1] !== declared[1]) {
                //a pool in the snapshot but absent from a freshly refreshed list is benign churn, not a provenance failure
                const msg = declared ? 'Pool tokens do not match the declared pair' : 'Pool is not in the current declared list'
                console.warn({msg, poolId: contractId, declared, onChain})
                return null
            }
            const rawReserves = [poolData.reserves[0].toString(), poolData.reserves[1].toString()]
            const kind = poolData.stableData ? 'stableswap' : poolData.concentratedData ? 'concentrated' : 'constant_product'
            let price = null
            if (poolData.stableData || poolData.concentratedData) {
                price = poolData.stableData
                    ? calculatePrice(poolData.reserves, poolData.stableData, periodTimestamp)
                    : calculateConcentratedPrice(poolData.concentratedData)
                if (price <= 0n) { //pool too shallow or uninitialized - no signal
                    console.debug({msg: 'Skipping pool with no computable price', poolId: contractId, kind, rawReserves, lastModifiedLedger})
                    return null
                }
                poolData.reserves = calculatePoolVolumes(poolData.reserves, price)
            }
            //single consolidated entry with everything needed to reconstruct how the pool volumes were formed
            console.debug({
                msg: 'Pool data processed',
                poolId: contractId,
                kind,
                rawReserves,
                price: price === null ? undefined : price.toString(),
                sqrtPriceX96: poolData.concentratedData?.sqrtPriceX96?.toString(),
                digits: poolData.concentratedData?.digits,
                volumes: [poolData.reserves[0].toString(), poolData.reserves[1].toString()],
                lastModifiedLedger
            })
            return poolData
        } catch (err) {
            console.error({msg: 'Error processing pool', poolId: contractId, err})
        }
        return null
    }
}

module.exports = AquaPoolProvider