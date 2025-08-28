/*eslint-disable class-methods-use-this */
const {Address} = require('@stellar/stellar-sdk')
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
     * @param {ContractDataEntry[]} poolInstances - pool data instances
     * @param {Asset} baseAsset - base asset
     * @param {Asset[]} assets - list of assets to aggregate pools data for
     * @param {string} network - network passphrase
     * @return {{reserves: BigInt[], asset: string}[]}
     */
    processPoolsData(poolInstances, baseAsset, assets, network) {
        const baseTokenId = PoolProviderBase.__getContractIdFromAsset(baseAsset, network)
        const assetTokenIds = new Map(assets.map(asset => [PoolProviderBase.__getContractIdFromAsset(asset, network), asset.toString()]))
        const result = []
        for (const instance of poolInstances) {
            const contractId = Address.contract(instance.key.contractData().contract().contractId()).toString()
            try {
                const {reserves, token, stableData} = extractAquaPoolData(
                    instance,
                    baseTokenId,
                    assetTokenIds
                )
                if (!reserves || reserves[0] === 0n || reserves[1] === 0n) {
                    console.debug(`Skipping pool with zero reserves: ${contractId}`)
                    continue
                }
                if (stableData) {
                    console.debug(`Stable pool ${contractId} raw reserves: ${reserves[0].toString()} / ${reserves[1].toString()}`)
                    reserves[0] = calculatePrice(reserves, stableData)
                    reserves[1] = adjustPrecision(1n, 0)
                }
                console.debug(`Pool ${contractId} reserves: [${reserves[0].toString()}, ${reserves[1].toString()}]`)
                result.push({
                    asset: assetTokenIds.get(token),
                    reserves
                })
            } catch (err) {
                console.error({msg: `Error processing pool ${contractId}`, err})
            }
        }
        return result
    }
}

module.exports = AquaPoolProvider