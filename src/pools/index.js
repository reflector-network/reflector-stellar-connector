const AquaPoolProvider = require('./aqua-pool-provider')
const PoolsDataAggregator = require('./pools-data-aggregator')

/**
 * @typedef {import('@stellar/stellar-sdk').Asset} Asset
 * @typedef {import('../cache')} TxCache
 * @typedef {import('../asset-volumes-accumulator')} AssetVolumesAccumulator
 * @typedef {import('./pool-provider-base')} PoolProviderBase
 */

const aquaPoolProvider = new AquaPoolProvider()

const poolProviders = [
    aquaPoolProvider
]

/**
 * Aggregate pools data for the specified base asset and assets
 * @param {TxCache} cache - Cache instance to store transactions
 * @param {string} baseAsset - base asset
 * @param {string[]} assets - tracked assets
 * @param {string} network - network passphrase
 * @param {number} from - start timestamp for aggregation
 * @param {number} period - period in seconds for aggregation
 * @param {number} limit - Number of periods to aggregate
 * @return {Promise<[AssetVolumesAccumulator[]]>} - Aggregated pools data for each period, but only the last period is filled with data
 */
function getPoolsData(cache, baseAsset, assets, network, from, period, limit) {
    try {
        //prepare results
        const results = []
        for (let i = 0; i < limit; i++) {
            const periodFrom = from + period * i
            const poolsDataAggregator = new PoolsDataAggregator(baseAsset, assets, network, periodFrom)
            //retrieve pools data for current period
            const poolsForPeriod = cache.getPoolsDataForPeriod(periodFrom, periodFrom + period)
            //accumulate pools data
            poolsDataAggregator.processTokenReserves(poolsForPeriod)
            //aggregate volumes
            const volumes = poolsDataAggregator.volumes
            //add to results
            results.push(volumes)
        }
        return results
    } catch (err) {
        console.error({msg: 'Error fetching dex data', err})
        return []
    }
}

/**
 * Load pools reserves data for the specified base asset and assets
 * @param {string} baseAsset - base asset to aggregate pools data against
 * @param {string[]} assets - list of assets to aggregate pools data for
 * @return {Promise<Map<string, PoolProviderBase>>} - list of pool contracts with their providers
 */
async function getPoolContracts(baseAsset, assets) {
    const loadPoolsPromises = []
    for (const provider of poolProviders) {
        loadPoolsPromises.push(loadSingleProviderData(provider, baseAsset, assets))
    }
    const providers = await Promise.all(loadPoolsPromises)
    let result = new Map()
    for (const provider of providers)
        result = new Map([...result, ...provider])
    return result
}

/**
 * Load reserves data for a single pool provider
 * @param {PoolProviderBase} provider - pool provider instance
 * @param {string} baseAsset - base asset to aggregate pools data against
 * @param {string[]} assets - list of assets to aggregate pools data for
 * @return {Promise<Map<string, PoolProviderBase>>} - list of pool contracts with their providers
 */
async function loadSingleProviderData(provider, baseAsset, assets) {
    try {
        const poolAddresses = await provider.getTargetPools(baseAsset, assets)
        const result = new Map()
        for (const address of poolAddresses) {
            result.set(address, provider)
        }
        return result
    } catch (err) {
        console.error({msg: 'Error processing pool data', err})
        return new Map()
    }
}

module.exports = {
    getPoolContracts,
    getPoolsData
}
