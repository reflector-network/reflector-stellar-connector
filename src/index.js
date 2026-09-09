const RpcConnector = require('./rpc-connector')
const {getDexVolumes} = require('./dex')
const {getPoolVolumes, getPoolContracts, configure: configurePools} = require('./pools')
const {getVWAP, scaleValue, TARGET_DECIMALS} = require('./utils')
const TxCache = require('./cache')

/**
 * @typedef {import('./asset-volumes-accumulator')} AssetVolumesAccumulator
 */

/**
 * Discovers all pools for the given assets
 * @param {string} baseAsset - base asset
 * @param {string[]} assets - assets
 * @param {string} network - network
 * @param {string[]} crossAssets - cross assets
 * @returns {Promise<Map<string, any>>}
 */
async function discoverPools(baseAsset, assets, network, crossAssets) {
    const filteredCrossAssets = crossAssets.filter(asset => asset !== baseAsset)
    //load base and cross-price pool contracts in parallel
    const [basePoolContracts, ...crossPoolContracts] = await Promise.all([
        getPoolContracts(baseAsset, assets, network),
        ...filteredCrossAssets.map(crossPriceAsset => getPoolContracts(crossPriceAsset, [baseAsset, ...assets], network))
    ])
    const allPoolContracts = new Map(basePoolContracts)
    for (const crossPools of crossPoolContracts) {
        for (const [k, v] of crossPools)
            allPoolContracts.set(k, v)
    }
    return allPoolContracts
}

/**
 * @param {TxCache} cache - transaction cache
 * @param {string} baseAsset - base asset
 * @param {string[]} assets - assets
 * @param {string} network - network
 * @param {number} from - from timestamp
 * @param {number} period - period in seconds
 * @param {number} count - count of periods
 * @param {string[]} crossAssets - list of cross-price assets
 * @returns {{volume: BigInt, quoteVolume: BigInt}[]}
 */
function getVolumesData(cache, baseAsset, assets, network, from, period, count, crossAssets) {
    const volumesData = [
        getDexVolumes(cache, baseAsset, assets, network, from, period, count),
        getPoolVolumes(cache, baseAsset, assets, network, from, period, count)
    ]
    for (const crossAsset of crossAssets.filter(asset => asset !== baseAsset)) {
        const crossAssetTradesData = getDexVolumes(
            cache,
            crossAsset,
            [baseAsset, ...assets],
            network,
            from,
            period,
            count
        )
        const crossAssetPoolsData = getPoolVolumes(
            cache,
            crossAsset,
            [baseAsset, ...assets],
            network,
            from,
            period,
            count
        )
        const normalized = normalizeCrossVolumes([crossAssetTradesData, crossAssetPoolsData], count, assets.length, crossAsset)
        volumesData.push(...normalized)
    }
    return volumesData
}

/**
 * Sum volumes and quote volumes, and returns aggregated result
 * @param {{volume: BigInt, quoteVolume: BigInt}[]} volumeData - volume data
 * @returns {{volume: BigInt, quoteVolume: BigInt}}
 */
function aggregateVolumes(volumeData) {
    const volume = volumeData.reduce((sum, data) => sum + (data?.volume || 0n), 0n)
    const quoteVolume = volumeData.reduce((sum, data) => sum + (data?.quoteVolume || 0n), 0n)
    return {volume, quoteVolume}
}

/**
 * Compute the price based on trades and pools data
 * @param {{volume: BigInt, quoteVolume: BigInt}[]} volumeData - volume data
 * @return {BigInt}
 */
function getPrice(volumeData) {
    const {volume, quoteVolume} = aggregateVolumes(volumeData)
    return getVWAP(volume, quoteVolume)
}

/**
 * Restate cross-asset-denominated volumes in baseAsset units, so they can be
 * aggregated alongside direct baseAsset/asset volumes.
 * For each period, slot 0 of every source is the crossAsset/baseAsset
 * accumulator and slots 1..assetCount are crossAsset/assets[c] accumulators.
 * Output is reindexed to the tracked-asset list only.
 * @param {Array} volumesData - cross-pair accumulators, one row per source
 * @param {number} count - number of periods
 * @param {number} assetCount - number of tracked assets
 * @param {string} crossAsset - cross-price asset (for logging)
 * @return {Array}
 */
function normalizeCrossVolumes(volumesData, count, assetCount, crossAsset) {
    const sourceCount = volumesData.length
    const result = Array.from({length: sourceCount}, () =>
        Array.from({length: count}, () =>
            Array.from({length: assetCount}, () => null)
        )
    )
    const scale = scaleValue(1n, TARGET_DECIMALS)
    for (let period = 0; period < count; period++) {
        //crossAsset-to-baseAsset rate aggregated across all sources
        const crossToBaseRate = getPrice(volumesData.map(src => src?.[period]?.[0]))
        if (crossToBaseRate === 0n)
            continue //skip period if no crossAsset/baseAsset data available
        console.debug({msg: 'Cross rate applied', crossAsset, period, crossToBaseRate: crossToBaseRate.toString()})
        for (let c = 0; c < assetCount; c++) {
            for (let src = 0; src < sourceCount; src++) {
                //slot c + 1 because slot 0 is the baseAsset accumulator
                const acc = volumesData[src]?.[period]?.[c + 1]
                if (!acc)
                    continue
                result[src][period][c] = {
                    volume: acc.volume * scale / crossToBaseRate,
                    quoteVolume: acc.quoteVolume
                }
            }
        }
    }
    return result
}

class StellarProvider {

    async init({rpcUrls, network, cacheDir}) {
        if (!rpcUrls || rpcUrls.length === 0) {
            throw new Error('Invalid RPC URLs')
        }
        if (!network) {
            throw new Error('Invalid network passphrase')
        }
        if (!cacheDir) {
            throw new Error('Invalid cache directory')
        }
        this.connector = new RpcConnector(rpcUrls, network)
        this.cache = new TxCache(this.connector)
        configurePools(cacheDir, this.connector)
        await Promise.resolve()
    }

    get network() {
        return this.connector.network
    }

    /**
     * Aggregate volumes per period and asset. Collapses all sources into a single volume/quoteVolume pair; caller aggregates across periods.
     * @param {Object} options
     * @param {string} options.baseAsset - base asset
     * @param {string[]} options.assets - tracked assets
     * @param {number} options.from - start timestamp (seconds)
     * @param {number} options.period - period length (seconds)
     * @param {number} options.count - number of periods
     * @param {string} [options.simSource] - account ID for simulateTransaction
     * @param {string[]} [options.crossAssets] - cross-price assets
     * @return {Array<Array<Array<{volume: BigInt, quoteVolume: BigInt, ts: number}>>>}
     */
    async getPriceData({baseAsset, assets, from, period, count, simSource, crossAssets}) {
        //set crossAssets if not provided
        if (!crossAssets) {
            crossAssets = []
        }
        //load pool contracts for the specified assets
        const allPoolContracts = await discoverPools(baseAsset, assets, this.network, crossAssets)
        //update cache with tokens metadata
        await this.cache.updateTokenMeta([baseAsset, ...assets], simSource)
        //update cache with recent transactions and pools data (merged contracts)
        await this.cache.updateCache(period, count, allPoolContracts)
        //load all trade and pool volumes data for base and cross assets
        const volumes = getVolumesData(this.cache, baseAsset, assets, this.network, from, period, count, crossAssets)
        //init result array of [period][asset] = [{volume, quoteVolume, ts}]
        const data = Array.from({length: count})
            .map(() => Array.from({length: assets.length}).map(() => null))
        for (let i = 0; i < count; i++) {
            const ts = from + period * i
            const summary = []
            for (let j = 0; j < assets.length; j++) {
                const assetVolumes = volumes.map(v => v?.[i]?.[j])
                const {volume, quoteVolume} = aggregateVolumes(assetVolumes)
                data[i][j] = [{
                    volume,
                    quoteVolume,
                    ts
                }]
                if (volume > 0n || quoteVolume > 0n) {
                    summary.push({asset: assets[j], volume: volume.toString(), quoteVolume: quoteVolume.toString()})
                }
            }
            //compact always-on trail of the final per-asset values handed to the node
            if (summary.length > 0) {
                console.info({msg: 'Volumes aggregated', baseAsset, ts, volumes: summary})
            }
        }
        return data
    }

    dispose() {
        this.cache.dispose()
    }
}

module.exports = StellarProvider
