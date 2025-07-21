/*eslint-disable class-methods-use-this */
const {DEFAULT_DECIMALS, adjustPrecision, getAquaPoolContractValues} = require('../utils')
const PoolProviderBase = require('./pool-provider-base')
const PoolType = require('./pool-type')


/**
 * Processes aquarius pool contracts
 * @param {ContractDataEntry} contractData - contracts data entries
 * @param {string} baseTokenId - base token contract id
 * @param {Map<string, string>} quoteTokenIds - quote token contract ids
 * @return {{reserves: BigInt[], token: string}} - reserves array. First element is base asset reserve, second is quote asset reserve.
 */
function extractAquaPoolData(contractData, baseTokenId, quoteTokenIds) {
    const storage = getAquaPoolContractValues(contractData, ['ReserveA', 'ReserveB', 'Reserves', 'Decimals', 'Tokens', 'TokenA', 'TokenB'])
    const digits = storage.Decimals !== undefined ? storage.Decimals : [DEFAULT_DECIMALS, DEFAULT_DECIMALS]
    const reserves = storage.ReserveA !== undefined
        ? [storage.ReserveA, storage.ReserveB]
        : [storage.Reserves[0], storage.Reserves[1]]
    const tokens = storage.Tokens || [storage.TokenA, storage.TokenB]
    if (
        !tokens //no tokens found
        || new Set(tokens).size !== 2 //not exactly 2 unique tokens
        || !tokens.includes(baseTokenId) //base token not found in pool
        || !quoteTokenIds.has(tokens.find(t => t !== baseTokenId)) //quote token not found
    ) {
        return [0n, 0n] //unable to extract reserves
    }
    if (tokens[1] === baseTokenId) //check if base token is second in the list
        reserves.reverse() //ensure base token is always first
    reserves[0] = adjustPrecision(reserves[0], digits[0])
    reserves[1] = adjustPrecision(reserves[1], digits[1])
    return {reserves, token: tokens.find(t => t !== baseTokenId)}
}

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
    async processPoolsData(poolInstances, baseAsset, assets, network) {
        const baseTokenId = PoolProviderBase.__getContractIdFromAsset(baseAsset, network)
        const assetTokenIds = new Map(assets.map(asset => [PoolProviderBase.__getContractIdFromAsset(asset, network), asset.toString()]))
        const result = []
        for (const instance of poolInstances) {
            const {reserves, token} = extractAquaPoolData(
                instance,
                baseTokenId,
                assetTokenIds
            )
            result.push({
                asset: assetTokenIds.get(token),
                reserves
            })
        }
        return result
    }
}

module.exports = AquaPoolProvider