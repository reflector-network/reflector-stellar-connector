const AquaPoolProvider = require('./aqua/aqua-pool-provider')
const PoolsDataAggregator = require('./pools-data-aggregator')
const StellarLiquidityPoolProvider = require('./stellar/stellar-liquidity-pool-provider')
const SushiPoolProvider = require('./sushi/sushi-pool-provider')

/**
 * @typedef {import('@stellar/stellar-sdk').Asset} Asset
 * @typedef {import('../cache')} TxCache
 * @typedef {import('../rpc-connector')} RpcConnector
 * @typedef {import('../asset-volumes-accumulator')} AssetVolumesAccumulator
 * @typedef {import('./pool-provider-base')} PoolProviderBase
 */

const aquaPoolProvider = new AquaPoolProvider()
const liquidityPoolProvider = new StellarLiquidityPoolProvider()
const sushiPoolProvider = new SushiPoolProvider()

const poolProviders = [
    aquaPoolProvider,
    liquidityPoolProvider,
    sushiPoolProvider
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
 * @param {{minBaseVolume: number}} guards - resolved pool guards
 * @return {Array<AssetVolumesAccumulator[]>} - Aggregated pools data for each period
 */
function getPoolVolumes(cache, baseAsset, assets, network, from, period, limit, guards) {
    //prepare results
    const results = []
    for (let i = 0; i < limit; i++) {
        const periodFrom = from + period * i
        const poolsDataAggregator = new PoolsDataAggregator(baseAsset, assets, network, periodFrom, guards)
        //retrieve pools data for current period
        const poolsForPeriod = cache.getPoolVolumesForPeriod(periodFrom, periodFrom + period)
        //accumulate pools data
        poolsDataAggregator.processTokenReserves(poolsForPeriod)
        //aggregate volumes
        const volumes = poolsDataAggregator.volumes
        //add to results
        results.push(volumes)
    }
    return results
}

/**
 * Load pools reserves data for the specified base asset and assets
 * @param {string} baseAsset - base asset to aggregate pools data against
 * @param {string[]} assets - list of assets to aggregate pools data for
 * @param {string} network - network passphrase
 * @return {Promise<Map<string, PoolProviderBase>>} - list of pool contracts with their providers
 */
async function getPoolContracts(baseAsset, assets, network) {
    const loadPoolsPromises = []
    for (const provider of poolProviders) {
        loadPoolsPromises.push(loadSingleProviderData(provider, baseAsset, assets, network))
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
 * @param {string} network - network passphrase
 * @return {Promise<Map<string, PoolProviderBase>>} - list of pool contracts with their providers
 */
async function loadSingleProviderData(provider, baseAsset, assets, network) {
    try {
        const poolAddresses = await provider.getTargetPools(baseAsset, assets, network)
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

/**
 * Configure pool providers that need on-disk persistence or RPC access.
 * @param {string} cacheDir - directory where pool provider caches are stored
 * @param {RpcConnector} rpcConnector - RPC connector for providers that discover pools on-chain
 */
function configure(cacheDir, rpcConnector) {
    aquaPoolProvider.configure(cacheDir)
    sushiPoolProvider.configure(rpcConnector)
}

module.exports = {
    getPoolContracts,
    getPoolVolumes,
    configure
}
