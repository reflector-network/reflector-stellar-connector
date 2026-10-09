/*eslint-disable class-methods-use-this */
const {Asset, getLiquidityPoolId, LiquidityPoolAsset, xdr, StrKey} = require('@stellar/stellar-sdk')
const {adjustPrecision, convertToStellarAsset, DEFAULT_DECIMALS, encodeXDRAssetToContractId} = require('../../utils')
const PoolProviderBase = require('../pool-provider-base')
const PoolType = require('../pool-type')
const {extractInstanceStorage} = require('../utils')


function extractPoolData(contractData, network) {
    const data = contractData?.value?.body?.value
    if (!data)
        return {}
    const reserves = [
        data.reserveA,
        data.reserveB
    ]
    const tokens = [
        encodeXDRAssetToContractId(data.params.assetA, network),
        encodeXDRAssetToContractId(data.params.assetB, network)
    ]

    reserves[0] = adjustPrecision(reserves[0], DEFAULT_DECIMALS)
    reserves[1] = adjustPrecision(reserves[1], DEFAULT_DECIMALS)
    return {reserves, tokens}
}

/**
 * Encode liquidity pool key for a pair of assets
 * @param {string[]} assets - assets to get a pair for
 * @return {string|null}
 */
function encodeLiquidityPoolKey(assets) {
    if (assets[0] === assets[1] || assets.some(a => StrKey.isValidContract(a)))
        return null //invalid pool
    const parseAssets = assets.map(convertToStellarAsset)
    parseAssets.sort(Asset.compare)
    const poolId = getLiquidityPoolId(
        'constant_product',
        new LiquidityPoolAsset(parseAssets[0], parseAssets[1], 30).getLiquidityPoolParameters()
    )
    //Buffer.from(view.buffer) ignores byteOffset/byteLength - copy the view itself
    const poolIdBytes = Buffer.from(poolId)
    if (poolIdBytes.length !== 32)
        throw new Error(`Unexpected liquidity pool id length: ${poolIdBytes.length}`)
    return poolIdBytes.toString('hex')
}

class StellarLiquidityPoolProvider extends PoolProviderBase {
    /**
     * Classic liquidity pools pairing the base asset with each tracked asset; computed from the pair, so it cannot fail
     * @param {string} baseAsset - oracle base token
     * @param {string[]} assets - tracked assets
     * @param {string} network - network passphrase
     * @return {Promise<Map<string, string[]>>} pool ids per asset
     */
    async getTargetPools(baseAsset, assets, network) {
        const result = new Map()
        for (const asset of assets) {
            const pools = []
            try {
                const poolKey = encodeLiquidityPoolKey([baseAsset, asset])
                if (poolKey) {
                    pools.push(poolKey)
                }
            } catch (err) {
                //one unusable pair must not remove every classic pool for this base asset
                console.warn({msg: 'Skipping liquidity pool pair', baseAsset, asset, network, err: err.message})
            }
            result.set(asset, pools)
        }
        return result
    }

    /**
     * Get pool type
     * @return {string}
     */
    get type() {
        return PoolType.STELLAR_LIQUIDITY
    }

    /**
     * @param {string} poolInstance - pool data instance in XDR format
     * @param {string} contractId - pool contract id
     * @param {string} network - network passphrase
     * @param {Map<string, {decimals: number}>} tokenMeta - Metadata for tokens to aggregate pools data for
     * @param {number} lastModifiedLedger - pool's last-modified ledger seq
     * @return {{reserves: BigInt[], tokens: string[]}|null} - pool reserves and tokens or null if the pool is invalid
     */
    processPoolInstance(poolInstance, contractId, network, tokenMeta, lastModifiedLedger) {
        try {
        //extract pool data
            const poolData = extractPoolData(extractInstanceStorage(poolInstance), network)

            //skip if pool is invalid
            if (!poolData || poolData.reserves.some(r => r <= 0n)) {
                console.debug({msg: 'Skipping invalid pool', poolId: contractId, lastModifiedLedger})
                return null
            }
            //single consolidated entry with everything needed to reconstruct how the pool volumes were formed
            console.debug({
                msg: 'Pool data processed',
                poolId: contractId,
                kind: 'classic',
                volumes: [poolData.reserves[0].toString(), poolData.reserves[1].toString()],
                lastModifiedLedger
            })
            return poolData
        } catch (err) {
            console.error({msg: 'Error processing pool', poolId: contractId, err})
        }
        return null
    }
}

module.exports = StellarLiquidityPoolProvider