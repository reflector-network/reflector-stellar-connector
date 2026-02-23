const RpcConnector = require('./rpc-connector')
const {getDexData} = require('./dex')
const {getPoolsData, getPoolContracts} = require('./pools')
const {convertToStellarAsset, getVWAP} = require('./utils')
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
        this.connector = new RpcConnector(rpcUrls)
        this.network = network
        this.cache = new TxCache(this.connector, network)
        await Promise.resolve()
    }

    /**
     * Aggregate trades and prices
     * @param {{
     *  baseAsset: {type: number, code: string},
     *  assets: {type: number, code: string}[],
     *  from: number,
     *  period: number,
     *  count: number
     * }} options - Options object
     * @return {[{price: BigInt, ts: number, type: string}][]}
     */
    async getPriceData({baseAsset, assets, from, period, count}) {

        //convert asset format
        const aggBaseAsset = convertToStellarAsset(baseAsset)
        const aggAssets = assets.map(a => convertToStellarAsset(a))

        //load pool contracts for the specified assets
        const poolContracts = await getPoolContracts(aggBaseAsset, aggAssets)

        //update cache with recent transactions and pools data
        await this.cache.updateCache(period, count, poolContracts)

        const tradesData = getDexData(this.cache, aggBaseAsset, aggAssets, this.network, from, period, count)
        const poolsData = getPoolsData(this.cache, aggBaseAsset, aggAssets, this.network, from, period, count)

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