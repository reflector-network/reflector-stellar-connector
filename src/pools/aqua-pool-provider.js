/*eslint-disable class-methods-use-this */
const {adjustPrecision, encodeAssetContractId, normalizeTimestamp} = require('../utils')
const {extractAquaPoolData, calculatePrice} = require('./aqua-pool-helper')
const PoolProviderBase = require('./pool-provider-base')
const PoolType = require('./pool-type')

class AquaPoolProvider extends PoolProviderBase {

    __lastUpdated = 0

    /**
     * @type {{address: string, type: string, assets: string}[]}
     * @private
     */
    __cached = null

    async __loadPools() {
        const data = []
        let dataSourceUrl = 'https://amm-api.aqua.network/pools/?size=500'
        while (dataSourceUrl) {
            const response = await fetch(dataSourceUrl)
                .then(res => res.json())
            dataSourceUrl = response.next
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
            let data = this.__cached
            const trimmedTs = normalizeTimestamp(Date.now(), 60 * 60 * 1000) //trim to hours in order to refresh every 60 minutes
            if (trimmedTs > this.__lastUpdated) {
                this.__cached = data = await this.__loadPools()
                this.__lastUpdated = trimmedTs
            }
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