const {processPoolData} = require('./pool-data-processor')
const {loadAquaPoolList} = require('./pool-data-provider')
const PoolsDataAggregator = require('./pools-data-aggregator')

/**
 * @typedef {import('@stellar/stellar-sdk').Asset} Asset
 * @typedef {import('../rpc-connector')} RpcConnector
 * @typedef {import('../asset-volumes-accumulator')} AssetVolumesAccumulator
 */

/**
 * Aggregate pools data
 * @param {RpcConnector} rpc - rpc connector instance
 * @param {Asset} baseAsset - Base asset
 * @param {Asset[]} assets - Tracked assets
 * @param {number} from - Start timestamp for aggregation
 * @param {number} period - Period in seconds for aggregation
 * @param {number} limit - Number of periods to aggregate
 * @return {Promise<AssetVolumesAccumulator[]>}
 */
async function getPoolsData(rpc, baseAsset, assets, from, period, limit) {
    const ts = from + period * (limit - 1)
    const poolsAggregator = new PoolsDataAggregator(baseAsset, assets, ts)
    const assetKeys = [...poolsAggregator.assets.keys()]
    const pools = (await Promise.all([loadAquaPoolList(poolsAggregator.baseAsset)]))
        .flat()
        .filter(pool => assetKeys.includes(pool.asset))
    if (!pools || pools.length === 0) {
        console.warn('No pools found for the specified base asset and assets')
        return []
    }
    const poolData = await processPoolData({
        contracts: pools.reduce((acc, pool) => acc.set(pool.contract, pool), new Map()),
        dataPromise: rpc.loadContractsData(pools.map(p => p.contract))
    }, poolsAggregator.baseTokenId)

    console.log(poolData)

    poolsAggregator.processTokenReserves(poolData)

    return poolsAggregator.volumes
}

module.exports = {
    getPoolsData
}