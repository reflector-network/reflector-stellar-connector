const RpcConnector = require('./rpc-connector')
const {getDexData} = require('./dex')
const {getPoolsData, getPoolContracts} = require('./pools')
const {getVWAP} = require('./utils')
const TxCache = require('./cache')

/**
 * @typedef {import('./asset-volumes-accumulator')} AssetVolumesAccumulator
 */


/**
 * Compute the price based on trades and pools data
 * @param {AssetVolumesAccumulator} tradesData - Aggregated trades data
 * @param {AssetVolumesAccumulator} poolsData - Aggregated pools data
 * @return {Bigint}
 */
function getPrice(tradesData, poolsData) {
    const volume = (tradesData?.volume || 0n) + (poolsData?.volume || 0n)
    const quoteVolume = (tradesData?.quoteVolume || 0n) + (poolsData?.quoteVolume || 0n)
    return getVWAP(volume, quoteVolume)
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
        return this.connector.networkPassphrase
    }

    /**
     * Aggregate trades and prices
     * @param {{
     *  baseAsset: {type: number, code: string},
     *  assets: {type: number, code: string}[],
     *  from: number,
     *  period: number,
     *  count: number,
     *  simSource: string
     * }} options - Options object
     * @return {[{price: BigInt, ts: number, type: string}][]}
     */
    async getPriceData({baseAsset, assets, from, period, count, simSource}) {
        const baseAssetCode = baseAsset.code
        const assetCodes = assets.map(a => a.code)
        //load pool contracts for the specified assets
        const poolContracts = await getPoolContracts(baseAssetCode, assetCodes)
        //update cache with tokens metadata
        await this.cache.updateTokenMeta([baseAssetCode, ...assetCodes], simSource)
        //update cache with recent transactions and pools data
        await this.cache.updateCache(period, count, poolContracts)

        const tradesData = getDexData(this.cache, baseAssetCode, assetCodes, this.network, from, period, count)
        const poolsData = getPoolsData(this.cache, baseAssetCode, assetCodes, this.network, from, period, count)

        const data = Array.from({length: count})
            .map(() => Array.from({length: assets.length})
                .map(() => ({price: 0n, ts: 0, type: 'price'}))) //empty results array
        //tradesData is an array of arrays, where each inner array corresponds to a period
        for (let i = 0; i < count; i++) {
            const ts = from + period * i
            for (let j = 0; j < assets.length; j++) {
                const price = getPrice(
                    tradesData[i]?.[j],
                    poolsData[i]?.[j]
                )
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