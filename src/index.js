const RpcConnector = require('./rpc-connector')
const {getDexVolumes} = require('./dex')
const {getPoolVolumes, getPoolContracts} = require('./pools')
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
    const poolContracts = await getPoolContracts(baseAsset, assets, network)
    //load cross pool contracts when cross-price is needed and merge into a single set
    let crossAssetsPoolContracts = new Map()
    for (const crossPriceAsset of crossAssets.filter(asset => asset !== baseAsset)) {
        const crossPriceAssetContracts = await getPoolContracts(crossPriceAsset, [baseAsset, ...assets], network)
        crossAssetsPoolContracts = new Map([...crossAssetsPoolContracts, ...crossPriceAssetContracts])
    }
    const allPoolContracts = new Map([...poolContracts, ...crossAssetsPoolContracts])
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
        const normalized = normalizeCrossVolumes([crossAssetTradesData, crossAssetPoolsData], count, assets.length)
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
 * Convert cross-price-based accumulator volumes to baseAsset-equivalent for each tracked asset in single period.
 * @param {[AssetVolumesAccumulator[]]} volumesData - trades data, asset at 0 is cross price asset
 * @param {number} count - number of periods
 * @param {number} assetCount - total assets count
 * @return {{volume: BigInt, quoteVolume: BigInt}[]}
 */
function normalizeCrossVolumes(volumesData, count, assetCount) {
    //init result
    const result = Array.from({length: volumesData.length})
        .map(() => Array.from({length: count}).map(() => null)
            .map(() => Array.from({length: assetCount}).map(() => null))
        )
    for (let i = 0; i < count; i++) {
    //get cross asset price
        const crossAssetPrice = getPrice(volumesData.map(v => v?.[i][0]))
        if (crossAssetPrice === 0n) //return empty result if no cross-price available
            return result
        const normalizeVolume = (volume) => volume * scaleValue(1n, TARGET_DECIMALS) / crossAssetPrice
        //calc price for each asset
        for (let c = 0; c < assetCount; c++) {
            for (let j = 0; j < volumesData.length; j++) {
                const assetData = volumesData[i][j]?.[c + 1]
                //convert to baseAsset volume
                if (assetData) {
                    result[i][j][c] = {
                        volume: normalizeVolume(assetData.volume),
                        quoteVolume: assetData.quoteVolume
                    }
                }
            }
        }
    }
    return result
}

class StellarProvider {

    async init({rpcUrls, network}) {
        if (!rpcUrls || rpcUrls.length === 0) {
            throw new Error('Invalid RPC URLs')
        }
        if (!network) {
            throw new Error('Invalid network passphrase')
        }
        this.connector = new RpcConnector(rpcUrls, network)
        this.cache = new TxCache(this.connector)
        await Promise.resolve()
    }

    get network() {
        return this.connector.network
    }

    /**
     * Aggregate trades and prices
     * @param {{
     *  baseAsset: string,
     *  assets: string[],
     *  from: number,
     *  period: number,
     *  count: number,
     *  simSource: string
     * }} options - Options object
     * @return {[{price: BigInt, ts: number, type: string}][]}
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
        //init result
        const data = Array.from({length: count})
            .map(() => Array.from({length: assets.length})
                .map(() => ({price: 0n, ts: 0, type: 'price'}))) //empty results array
        //tradesData is an array of arrays, where each inner array corresponds to a period
        for (let i = 0; i < count; i++) {
            const ts = from + period * i
            for (let j = 0; j < assets.length; j++) {
                const assetVolumes = volumes.map(v => v?.[i]?.[j])
                const price = getPrice(assetVolumes)
                data[i][j] = [{
                    price,
                    ts,
                    type: 'price'
                }]
            }
        }
        return data
    }
}

module.exports = StellarProvider
