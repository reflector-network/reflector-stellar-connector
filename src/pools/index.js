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

const providersByType = new Map(poolProviders.map(provider => [provider.type, provider]))

/**
 * The pool providers to run and their settings. reflector-node passes a data source's `providers` block here as
 * `options.sources`; every node of a cluster must pass the same one, or their volumes differ
 * @param {Object.<string, object>|string[]|undefined} sources - provider settings by provider type, or provider types
 * @return {{provider: PoolProviderBase, settings: object}[]}
 */
function resolvePoolSources(sources) {
    const all = () => poolProviders.map(provider => ({provider, settings: {}}))
    if (sources === undefined || sources === null)
        return all()
    let entries = null
    if (Array.isArray(sources)) {
        entries = sources.map(name => [name, {}])
    } else if (typeof sources === 'object') {
        entries = Object.entries(sources)
    } else {
        console.warn({msg: 'Pool provider sources must be an object or an array - using all providers', type: typeof sources})
        return all()
    }
    const enabled = []
    const unknown = []
    for (const [name, settings] of entries) {
        const provider = providersByType.get(name)
        if (!provider) {
            unknown.push(name)
            continue
        }
        enabled.push({provider, settings: settings && typeof settings === 'object' ? settings : {}})
    }
    if (unknown.length > 0)
        console.warn({msg: 'Unknown pool providers ignored', providers: unknown})
    return enabled
}

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
 * Discover the pools of the base asset and tracked assets, and which assets discovery tried
 * @param {string} baseAsset - base asset
 * @param {string[]} assets - tracked assets
 * @param {string} network - network passphrase
 * @param {{provider: PoolProviderBase, settings: object}[]} enabledProviders - resolvePoolSources result
 * @return {Promise<{contracts: Map<string, PoolProviderBase>, validAssets: Set<string>}>} the pools with their
 * providers, and the assets whose pools were tried: some provider found pools for the asset, or every provider answered
 */
async function getPoolContracts(baseAsset, assets, network, enabledProviders) {
    const results = await Promise.all(enabledProviders.map(({provider, settings}) =>
        provider.getTargetPools(baseAsset, assets, network, settings)
            .then(pools => ({provider, pools}), err => ({provider, err}))))
    const contracts = new Map()
    const withPools = new Set()
    let failed = false
    for (const {provider, pools, err} of results) {
        if (err) {
            failed = true
            console.error({msg: 'Pool discovery failed', provider: provider.type, baseAsset, network, err})
            continue
        }
        for (const [asset, ids] of pools) {
            for (const id of ids)
                contracts.set(id, provider)
            if (ids.length > 0)
                withPools.add(asset)
        }
    }
    //a failed provider may hold the only pools of an asset that shows none, so such an asset was not tried
    const validAssets = new Set(assets.filter(asset => withPools.has(asset) || !failed))
    return {contracts, validAssets}
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
    resolvePoolSources,
    getPoolVolumes,
    configure
}
