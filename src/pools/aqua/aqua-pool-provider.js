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

/**
 * The pool lists a cache file holds, with the URL each came from
 * @param {*} parsed - parsed cache file contents
 * @return {[string, object[]][]}
 */
function readCachedLists(parsed) {
    //written before the list URL was configurable: it came from the default URL
    if (Array.isArray(parsed))
        return [[AQUA_API_URL, parsed]]
    //written when the provider kept a single list
    if (parsed && typeof parsed.url === 'string' && Array.isArray(parsed.pools))
        return [[parsed.url, parsed.pools]]
    if (parsed && parsed.lists && typeof parsed.lists === 'object')
        return Object.entries(parsed.lists).filter(([, pools]) => Array.isArray(pools))
    return []
}

/**
 * @typedef {Object} AquaPoolList
 * @property {{address: string, type: string, assets: string[]}[]|null} pools - the last list loaded from the URL
 * @property {number} lastUpdated - the hour of the last successful refresh
 * @property {number} failedAt - when the last refresh failed; 0 once one succeeds
 * @property {Promise|null} refreshPromise - in-flight refresh shared by concurrent callers
 */

class AquaPoolProvider extends PoolProviderBase {

    /**
     * Pool lists by the URL they came from. Every data source of a node shares this provider, and each URL indexes
     * one network, so a URL keeps its own list, refresh schedule and failure cooldown, and lists never mix
     * @type {Map<string, AquaPoolList>}
     * @private
     */
    __lists = new Map()

    /**
     * Token pair the API claimed for each pool address, by network, checked against the pool's own storage before use
     * @type {Map<string, Map<string, string[]>>}
     * @private
     */
    __declaredTokens = new Map()

    /**
     * @type {string|null}
     * @private
     */
    __cacheFile = null

    /**
     * Cache file writes run one after another: the lists of several URLs can refresh at once, and two writes sharing
     * the tmp file would race on its rename
     * @type {Promise}
     * @private
     */
    __persistQueue = Promise.resolve()

    /**
     * Configure on-disk cache location and load any existing snapshot.
     * @param {string} cacheDir - directory where the cache file is stored
     */
    configure(cacheDir) {
        this.__cacheFile = path.join(cacheDir, AQUA_CACHE_FILENAME)
        try {
            const parsed = JSON.parse(fs.readFileSync(this.__cacheFile, 'utf8'))
            for (const [url, pools] of readCachedLists(parsed)) {
                this.__getList(url).pools = pools
            }
        } catch (err) {
            if (err.code !== 'ENOENT') {
                console.warn({msg: 'Failed to load Aqua pool cache from disk', file: this.__cacheFile, err})
            }
        }
    }

    /**
     * @param {string} url - pool list URL
     * @return {AquaPoolList}
     * @private
     */
    __getList(url) {
        let list = this.__lists.get(url)
        if (!list) {
            list = {pools: null, lastUpdated: 0, failedAt: 0, refreshPromise: null}
            this.__lists.set(url, list)
        }
        return list
    }

    __persistCache() {
        const write = this.__persistQueue.then(() => this.__writeCache())
        this.__persistQueue = write
        return write
    }

    async __writeCache() {
        if (!this.__cacheFile)
            return
        const lists = {}
        for (const [url, {pools}] of this.__lists) {
            if (pools)
                lists[url] = pools
        }
        const tmpFile = this.__cacheFile + '.tmp'
        try {
            await fs.promises.writeFile(tmpFile, JSON.stringify({lists}))
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
        //the hourly schedule and the failure cooldown belong to one list URL: a URL not seen before is loaded at once
        const list = this.__getList(url)
        if (list.refreshPromise) { //refresh of this URL already in progress - wait for it instead of starting another one
            await list.refreshPromise
            return
        }
        const now = Date.now()
        const trimmedTs = normalizeTimestamp(now, 60 * 60 * 1000) //trim to hours in order to refresh every 60 minutes
        if (trimmedTs <= list.lastUpdated)
            return
        //the host alone is logged, because a list URL can carry a key in its path or query
        const {host} = new URL(url)
        if (list.failedAt && now - list.failedAt < AQUA_FAILURE_COOLDOWN_MS) {
            //within failure cooldown - keep stale cache
            console.warn({msg: 'Aqua pool refresh in cooldown - using stale pool list', host, failedAt: list.failedAt, retryAfter: list.failedAt + AQUA_FAILURE_COOLDOWN_MS})
            return
        }
        list.refreshPromise = (async () => {
            try {
                list.pools = await this.__loadPools(url)
                list.lastUpdated = trimmedTs
                list.failedAt = 0
                await this.__persistCache()
            } catch (err) {
                list.failedAt = now
                console.error({msg: `Error loading pool list for ${this.constructor.name} provider`, host, err})
            } finally {
                list.refreshPromise = null
            }
        })()
        await list.refreshPromise
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
     * @param {{aquaListUrl: string}} [settings] - provider settings from the data source; unset means the default URL,
     * which indexes pubnet only
     * @return {Promise<Map<string, string[]>>} pool addresses per asset; rejects when there is no pool list
     */
    async getTargetPools(baseAsset, assets, network, settings = {}) {
        const result = new Map(assets.map(asset => [asset, []]))
        //the default list indexes pubnet; on another network its addresses are unrelated contract ids, so another
        //network is served only from a list URL set for it
        if (network !== Networks.PUBLIC && (settings.aquaListUrl === undefined || settings.aquaListUrl === null)) {
            console.debug({msg: 'Aqua pool provider has no aquaListUrl for this network', network})
            return result
        }
        const url = resolveListUrl(settings.aquaListUrl)
        await this.__maybeRefreshPools(url)
        const data = this.__lists.get(url).pools
        //without a list from this URL the provider has not answered, and must not read as "no pools"; the host
        //alone is named, because a list URL can carry a key in its path or query
        if (!data)
            throw new Error(`No Aqua pool list loaded from ${new URL(url).host}`)
        //remember what the API claims each pool of this network holds, so the on-chain instance can be checked against it
        this.__declaredTokens.set(network, new Map(data.map(pool => [pool.address, [...pool.assets].sort()])))
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
            const declared = this.__declaredTokens.get(network)?.get(contractId)
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