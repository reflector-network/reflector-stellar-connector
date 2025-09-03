const RpcConnector = require('./rpc-connector')
const {getDexData} = require('./dex')
const {getPoolsData} = require('./pools')
const {normalizeTimestamp, convertToStellarAsset, getVWAP, TARGET_DECIMALS} = require('./utils')
const TradesCache = require('./dex/cache')

/**
 * @typedef {import('./asset-volumes-accumulator')} AssetVolumesAccumulator
 */

const cache = new TradesCache()

/**
 * Aggregate trades and prices
 * @param {{
 *  rpcUrl: string,
 *  baseAsset: {type: number, code: string},
 *  assets: {type: number, code: string}[],
 *  network: string,
 *  from: number,
 *  period: number,
 *  limit: number
 * }} options - Options object
 * @return {[{price: BigInt, ts: number, type: string}][]}
 */
async function aggregateTrades({rpcUrl, network, baseAsset, assets, from, period, limit}) {
    //convert asset format
    const aggBaseAsset = convertToStellarAsset(baseAsset)
    const aggAssets = assets.map(a => convertToStellarAsset(a))
    const rpc = new RpcConnector(rpcUrl, cache)
    const tradesDataPromise = getDexData(rpc, aggBaseAsset, aggAssets, from, period, limit)
    const poolsDataPromise = getPoolsData(rpc, network, aggBaseAsset, aggAssets, from, period, limit)
    //wait for both promises to resolve
    const [tradesData, poolsData] = await Promise.all([tradesDataPromise, poolsDataPromise])

    const aggregatorDataToLog = (aggrData) => {
        const logData = []
        for (const tsData of aggrData) {
            for (const assetData of tsData) {
                logData.push({
                    asset: assetData.asset,
                    volume: assetData.volume.toString(),
                    quoteVolume: assetData.quoteVolume.toString(),
                    ts: assetData.ts
                })
            }
        }
        return logData
    }

    console.debug({msg: 'Aggregated trades data', data: aggregatorDataToLog(tradesData)})
    console.debug({msg: 'Aggregated pools data', data: aggregatorDataToLog(poolsData)})

    const data = Array.from({length: tradesData.length})
        .map(() => Array.from({length: assets.length})
            .map(() => ({price: 0n, ts: 0, type: 'price'}))) //empty results array
    //tradesData is an array of arrays, where each inner array corresponds to a period
    for (let i = 0; i < limit; i++) {
        const ts = from + period * i
        for (let j = 0; j < assets.length; j++) {
            const price = getPrice(
                tradesData[i]?.[j],
                poolsData[i]?.[j]
            )
            data[i][j] = {
                price,
                ts,
                type: 'price'
            }
        }
    }
    console.debug({msg: 'Aggregated prices', data: data.map(dItem => dItem.map(p => ({...p, price: p.price.toString()})))})
    return data
}

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

module.exports = {
    aggregateTrades,
    normalizeTimestamp
}