/*eslint-disable class-methods-use-this */
const {encodeAssetContractId} = require('../utils')

const tokenIdCache = new Map()

function getContractIdFromAsset(asset, network) {
    let networkCache = tokenIdCache.get(network)
    if (!networkCache) {
        networkCache = new Map()
        tokenIdCache.set(network, networkCache)
    }
    let tokenId = tokenIdCache.get(asset)
    if (!tokenId) {
        tokenId = encodeAssetContractId(asset, network)
        tokenIdCache.set(asset, tokenId)
    }
    return tokenId
}

class PoolProviderBase {
    constructor() {
        if (this.constructor === PoolProviderBase)
            throw new Error("Cannot instantiate abstract class PoolProviderBase")
    }

    __lastUpdated = 0

    /**
     * @type {{address: string, type: string, assets: string}[]}
     * @private
     */
    __cached = null

    /**
     * Get pool type
     * @type {string}
     */
    get type() {
        throw new Error("Abstract method type must be implemented in derived class")
    }

    /**
     * Returns a map of pools for the given base asset and assets.
     * @param {string} baseAsset - oracle base token
     * @param {string[]} assets - oracle base token
     * @return {string[]}
     */
    async getTargetPools(baseAsset, assets) {
        try {
            let data = this.__cached
            const trimmedTs = new Date().getTime() / 60 * 60 * 1000 //trim to hours in order to refresh every 60 minutes
            if (trimmedTs > this.__lastUpdated) {
                this.__cached = data = await this.__loadPools()
                this.__lastUpdated = trimmedTs
            }
            const baseAssetStr = baseAsset.toString()
            const assetsStr = assets.map(a => a.toString())
            const getQuoteAssetFn = (pool) => {
                if (!pool.type //check if pool has type
                || !pool.assets //check if pool has assets
                || pool.assets.length !== 2 //check for 2 assets
                || new Set(pool.assets).size !== 2 //check for duplicates
                ) {
                    console.warn(`Skipping pool with invalid data: ${JSON.stringify(pool)}`)
                    return null
                }
                const poolQuoteAsset = pool.assets.find(a => a !== baseAssetStr)
                if (!(pool.assets.includes(baseAssetStr) && assetsStr.includes(poolQuoteAsset))) {
                    return null
                }
                return poolQuoteAsset
            }

            const targetPools = []
            for (const pool of data) {
                const quoteAsset = getQuoteAssetFn(pool)
                if (!quoteAsset)
                    continue
                targetPools.push(pool.address)
                console.debug(`Found pool ${baseAssetStr}-${quoteAsset}-${pool.address}-${pool.type}`)
            }
            return targetPools
        } catch (err) {
            console.error({msg: `Error loading pool list for ${this.constructor.name} provider`, err})
            return []
        }
    }

    /**
     * Loads pools data from the provider.
     * @return {{address: string, type: string, assets: string}[]}
     * @protected
     */
    async __loadPools() {
        throw new Error("Abstract method __getPoolsData must be implemented in derived class")
    }


    /**
     * @param {ContractDataEntry[]} poolInstances - pool data instances
     * @param {Asset} baseAsset - base asset
     * @param {Asset[]} assets - list of assets to aggregate pools data for
     * @param {string} network - network passphrase
     * @return {{reserves: BigInt[], asset: Asset}[]}
     */
    processPoolsData(poolInstances, baseAsset, assets, network) {
        throw new Error("Abstract method processPoolsData must be implemented in derived class")
    }

    static __getContractIdFromAsset(asset, network) {
        return getContractIdFromAsset(asset, network)
    }
}

module.exports = PoolProviderBase