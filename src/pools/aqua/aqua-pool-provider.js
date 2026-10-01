/*eslint-disable class-methods-use-this */
const fs = require('fs')
const path = require('path')
const {Networks} = require('@stellar/stellar-sdk')
const {encodeAssetContractId, normalizeTimestamp} = require('../../utils')
const {calculateConcentratedPrice, calculatePoolVolumes} = require('../utils')
const PoolProviderBase = require('../pool-provider-base')
const PoolType = require('../pool-type')
const {loadAquaPools} = require('./aqua-api')
const {extractAquaPoolData, calculatePrice} = require('./aqua-pool-helper')

const AQUA_FAILURE_COOLDOWN_MS = 5 * 60 * 1000
const AQUA_CACHE_FILENAME = 'aqua-pools.json'

class AquaPoolProvider extends PoolProviderBase {

    __lastUpdated = 0

    __failedAt = 0

    /**
     * @type {{address: string, type: string, assets: string}[]}
     * @private
     */
    __cached = null

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
                this.__cached = parsed
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
            await fs.promises.writeFile(tmpFile, JSON.stringify(this.__cached))
            await fs.promises.rename(tmpFile, this.__cacheFile)
        } catch (err) {
            console.error({msg: 'Failed to persist Aqua pool cache to disk', file: this.__cacheFile, err})
        }
    }

    /**
     * Load the pool list from the Aqua API with its request limits applied
     * @returns {Promise<{address: string, assets: string[], type: string}[]>}
     */
    async __loadPools() {
        return await loadAquaPools()
    }

    async __maybeRefreshPools() {
        if (this.__refreshPromise) { //refresh already in progress - wait for it instead of starting another one
            await this.__refreshPromise
            return
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
                this.__cached = await this.__loadPools()
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
     * Returns a map of pools for the given base asset and assets.
     * @param {string} baseAsset - oracle base token
     * @param {string[]} assets - oracle base token
     * @param {string} network - network passphrase
     * @return {string[]}
     */
    async getTargetPools(baseAsset, assets, network) {
        try {
            //the Aqua API indexes pubnet only; matching its addresses on another network compares unrelated contract ids
            if (network !== Networks.PUBLIC) {
                console.debug({msg: 'Aqua pool provider serves pubnet only', network})
                return []
            }
            await this.__maybeRefreshPools()
            const data = this.__cached
            if (!data)
                return []
            //remember what the API claims each pool holds, so the on-chain instance can be checked against it
            this.__declaredTokens = new Map(data.map(pool => [pool.address, [...pool.assets].sort()]))
            const baseToken = encodeAssetContractId(baseAsset, network)
            const tokens = assets.map(a => encodeAssetContractId(a, network))
            const getQuoteTokenFn = (pool) => {
                if (!pool.type //check if pool has type
                || !pool.assets //check if pool has assets
                || pool.assets.length !== 2 //check for 2 assets
                || new Set(pool.assets).size !== 2 //check for duplicates
                ) {
                    console.warn({msg: 'Skipping pool with invalid data', poolId: pool.address, type: pool.type, assets: pool.assets})
                    return null
                }
                const poolQuoteToken = pool.assets.find(a => a !== baseToken)
                if (!(pool.assets.includes(baseToken) && tokens.includes(poolQuoteToken))) {
                    return null
                }
                return poolQuoteToken
            }

            const targetPools = []
            for (const pool of data) {
                const quoteToken = getQuoteTokenFn(pool)
                if (!quoteToken)
                    continue
                targetPools.push(pool.address)
            }
            console.debug({msg: 'Pools found', baseAsset: baseToken, pools: targetPools})
            return targetPools
        } catch (err) {
            console.error({msg: `Error loading pool list for ${this.constructor.name} provider`, err})
            return []
        }
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