const AquaPoolProvider = require('./aqua-pool-provider')
const PoolsDataAggregator = require('./pools-data-aggregator')

/**
 * @typedef {import('@stellar/stellar-sdk').Asset} Asset
 * @typedef {import('../rpc-connector')} RpcConnector
 * @typedef {import('../asset-volumes-accumulator')} AssetVolumesAccumulator
 * @typedef {import('./pool-provider-base')} PoolProviderBase
 */

const aquaPoolProvider = new AquaPoolProvider()

/**
 * Aggregate pools data
 * @param {RpcConnector} rpc - rpc connector instance
 * @param {string} network - network passphrase
 * @param {Asset} baseAsset - base asset
 * @param {Asset[]} assets - tracked assets
 * @param {number} from - start timestamp for aggregation
 * @param {number} period - period in seconds for aggregation
 * @param {number} limit - Number of periods to aggregate
 * @return {Promise<[AssetVolumesAccumulator[]]>} - Aggregated pools data for each period, but only the last period is filled with data
 */
async function getPoolsData(rpc, network, baseAsset, assets, from, period, limit) {
    try {
        const ts = from + period * (limit - 1)
        //load pool reserves data
        const totalReserves = await loadPoolReserves(rpc, network, baseAsset, assets)
        if (!totalReserves || totalReserves.length === 0) {
            console.warn('No pool reserves data found')
            return []
        }
        //process pool reserves data
        const poolsAggregator = new PoolsDataAggregator(baseAsset, assets, ts)
        poolsAggregator.processTokenReserves(totalReserves)
        const result = Array.from({length: limit}).fill([])
        result[limit - 1] = poolsAggregator.volumes
        return result
    } catch (err) {
        console.error({msg: 'Error fetching pools data', err})
        return []
    }
}

/**
 * Load pools reserves data for the specified base asset and assets
 * @param {RpcConnector} rpc - rpc connector instance
 * @param {string} network - network passphrase
 * @param {Asset} baseAsset - base asset to aggregate pools data against
 * @param {Asset[]} assets - list of assets to aggregate pools data for
 */
async function loadPoolReserves(rpc, network, baseAsset, assets) {
    const loadPoolsPromises = [
        loadSingleProviderData(rpc, network, aquaPoolProvider, baseAsset, assets)
    ]
    const allPools = await Promise.all(loadPoolsPromises)
    return allPools.flat()
}


/**
 * Load reserves data for a single pool provider
 * @param {RpcConnector} rpc - rpc connector instance
 * @param {string} network - network passphrase
 * @param {PoolProviderBase} provider - pool provider instance
 * @param {Asset} baseAsset - base asset to aggregate pools data against
 * @param {Asset[]} assets - list of assets to aggregate pools data for
 * @return {Promise<{reserves: BigInt[], asset: string}[]>}
 */
async function loadSingleProviderData(rpc, network, provider, baseAsset, assets) {
    try {
        const poolAddresses = await provider.getTargetPools(baseAsset, assets)
        const poolInstances = await rpc.loadContractsData(poolAddresses)
        const reservesData = provider.processPoolsData(poolInstances, baseAsset, assets, network)
        return reservesData
    } catch (err) {
        console.error('Error processing pool data:', err)
        return []
    }
}

module.exports = {
    getPoolsData
}
