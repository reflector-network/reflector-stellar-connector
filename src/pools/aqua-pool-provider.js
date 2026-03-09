/*eslint-disable class-methods-use-this */
const {adjustPrecision} = require('../utils')
const {extractAquaPoolData, calculatePrice} = require('./aqua-pool-helper')
const PoolProviderBase = require('./pool-provider-base')
const PoolType = require('./pool-type')

class AquaPoolProvider extends PoolProviderBase {

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
                    || pool.tokens_str.length !== 2
                ) //skip pools that are killed, unsupported types or with more than 2 tokens
                    return null

                return ({
                    address: pool.address,
                    assets: pool.tokens_str,
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