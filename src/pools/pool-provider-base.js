/*eslint-disable class-methods-use-this */
const {encodeAssetContractId} = require('../utils')

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
     * @param {string} network - network passphrase
     * @return {string[]}
     */
    async getTargetPools(baseAsset, assets, network) {
        try {
            let data = this.__cached
            const trimmedTs = new Date().getTime() / 60 * 60 * 1000 //trim to hours in order to refresh every 60 minutes
            if (trimmedTs > this.__lastUpdated) {
                this.__cached = data = await this.__loadPools()
                this.__lastUpdated = trimmedTs
            }
            const baseToken = encodeAssetContractId(baseAsset, network)
            const tokens = assets.map(a => encodeAssetContractId(a, network))
            const getQuoteTokenFn = (pool) => {
                if (!pool.type //check if pool has type
                || !pool.tokens_addresses //check if pool has tokens_addresses
                || pool.tokens_addresses.length !== 2 //check for 2 assets
                || new Set(pool.tokens_addresses).size !== 2 //check for duplicates
                ) {
                    console.warn({msg: 'Skipping pool with invalid data', poolId: pool.address, type: pool.type, assets: pool.tokens_addresses})
                    return null
                }
                const poolQuoteToken = pool.tokens_addresses.find(a => a !== baseToken)
                if (!(pool.tokens_addresses.includes(baseToken) && tokens.includes(poolQuoteToken))) {
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
     * Loads pools data from the provider.
     * @return {{address: string, type: string, assets: string}[]}
     * @protected
     */
    async __loadPools() {
        throw new Error("Abstract method __getPoolsData must be implemented in derived class")
    }


    /**
     * @param {string} poolInstance - pool data instances
     * @param {string} contractId - pool contract id
     * @param {string} network - network passphrase
     * @param {Map<string, {decimals: number}>} tokenMeta - Metadata for tokens to aggregate pools data for
     * @return {{reserves: BigInt[], tokens: string[]}|null} - pool reserves and tokens or null if the pool is invalid.
     */
    processPoolInstance(poolInstance, contractId, network, tokenMeta) {
        throw new Error("Abstract method processPoolInstance must be implemented in derived class")
    }
}

module.exports = PoolProviderBase