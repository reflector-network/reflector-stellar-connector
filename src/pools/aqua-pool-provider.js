/*eslint-disable class-methods-use-this */
const fs = require('fs')
const path = require('path')
const {adjustPrecision, encodeAssetContractId, normalizeTimestamp} = require('../utils')
const {extractAquaPoolData, calculatePrice} = require('./aqua-pool-helper')
const PoolProviderBase = require('./pool-provider-base')
const PoolType = require('./pool-type')

const AQUA_API_HOST = 'amm-api.aqua.network'
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
     * @type {string|null}
     * @private
     */
    __cacheFile = null

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

    async __loadPools() {
        const data = []
        let dataSourceUrl = `https://${AQUA_API_HOST}/pools/?size=500`
        while (dataSourceUrl) {
            const response = await fetch(dataSourceUrl)
                .then(res => res.json())
            //validate next URL host to avoid following untrusted redirects
            if (response.next) {
                let nextHost = null
                try {
                    nextHost = new URL(response.next).host
                } catch (_) { /*invalid URL */ }
                if (nextHost !== AQUA_API_HOST) {
                    console.warn({msg: 'Aquarius API returned untrusted next URL, stopping pagination', next: response.next})
                    dataSourceUrl = null
                } else {
                    dataSourceUrl = response.next
                }
            } else {
                dataSourceUrl = null
            }
            const parsedData = response.items.map(pool => {
                let type
                switch (pool.pool_type) {
                    case 'constant_product':
                        type = 'constant_product'
                        break
                    case 'stable':
                        type = 'stableswap'
                        break
                    default:
                        console.log('Aquarius pool type not supported: ' + pool.pool_type)
                }
                if (pool.swap_killed
                    || !type
                    || pool.tokens_addresses.length !== 2
                ) //skip pools that are killed, unsupported types or with more than 2 tokens
                    return null

                return ({
                    address: pool.address,
                    assets: pool.tokens_addresses,
                    type
                })
            }).filter(value => !!value)
            data.push(...parsedData)
        }
        return data
    }

    async __maybeRefreshPools() {
        const now = Date.now()
        const trimmedTs = normalizeTimestamp(now, 60 * 60 * 1000) //trim to hours in order to refresh every 60 minutes
        if (trimmedTs <= this.__lastUpdated)
            return
        if (this.__failedAt && now - this.__failedAt < AQUA_FAILURE_COOLDOWN_MS)
            return //within failure cooldown - keep stale cache
        try {
            this.__cached = await this.__loadPools()
            this.__lastUpdated = trimmedTs
            this.__failedAt = 0
            await this.__persistCache()
        } catch (err) {
            this.__failedAt = now
            console.error({msg: `Error loading pool list for ${this.constructor.name} provider`, err})
        }
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
            await this.__maybeRefreshPools()
            const data = this.__cached
            if (!data)
                return []
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
     * @return {{reserves: BigInt[], tokens: string[]}|null} - pool reserves and tokens or null if the pool is invalid
     */
    processPoolInstance(poolInstance, contractId, network, tokenMeta) {
        try {
            //extract pool data
            const poolData = extractAquaPoolData(poolInstance, tokenMeta)

            //skip if pool is invalid
            if (!poolData || poolData.reserves.some(r => r <= 0n)) {
                console.debug({msg: 'Skipping invalid pool', poolId: contractId})
                return null
            }
            if (poolData.stableData) {
                console.debug({msg: 'Stable pool raw reserves', poolId: contractId, reserves: [poolData.reserves[0].toString(), poolData.reserves[1].toString()]})
                poolData.reserves[0] = calculatePrice(poolData.reserves, poolData.stableData)
                poolData.reserves[1] = adjustPrecision(1n, 0)
            }
            console.debug({msg: 'Pool reserves', poolId: contractId, reserves: [poolData.reserves[0].toString(), poolData.reserves[1].toString()]})
            return poolData
        } catch (err) {
            console.error({msg: 'Error processing pool', poolId: contractId, err})
        }
        return null
    }
}

module.exports = AquaPoolProvider