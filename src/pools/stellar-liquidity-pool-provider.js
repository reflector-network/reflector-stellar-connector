/*eslint-disable class-methods-use-this */
const {Asset, getLiquidityPoolId, LiquidityPoolAsset, xdr, StrKey} = require('@stellar/stellar-sdk')
const {adjustPrecision, convertToStellarAsset, DEFAULT_DECIMALS, encodeXDRAssetToContractId} = require('../utils')
const PoolProviderBase = require('./pool-provider-base')
const PoolType = require('./pool-type')


function extractPoolData(contractData, network) {
    const data =
xdr.LedgerEntryData.fromXDR(contractData, 'base64')?.value()?.body?.()?.value?.()
    if (!data)
        return {}
    const reserves = [
        data.reserveA().toBigInt(),
        data.reserveB().toBigInt()
    ]
    const tokens = [
        encodeXDRAssetToContractId(data.params().assetA(), network),
        encodeXDRAssetToContractId(data.params().assetB(), network)
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
    return poolId.toString('hex')
}

class StellarLiquidityPoolProvider extends PoolProviderBase {
    /**
     * Returns a map of pools for the given base asset and assets.
     * @param {string} baseAsset - oracle base token
     * @param {string[]} assets - oracle base token
     * @param {string} network - network passphrase
     * @return {string[]}
     */
    async getTargetPools(baseAsset, assets, network) {
        try {
            const liquidityPools = []
            for (const asset of assets) {
                const poolKey = encodeLiquidityPoolKey([baseAsset, asset])
                if (poolKey) {
                    liquidityPools.push(poolKey)
                }
            }
            return liquidityPools
        } catch (err) {
            console.error({msg: 'Error getting target pools', baseAsset, assets, network, err})
            throw err
        }
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
     * @return {{reserves: BigInt[], tokens: string[]}|null} - pool reserves and tokens or null if the pool is invalid
     */
    processPoolInstance(poolInstance, contractId, network, tokenMeta) {
        try {
        //extract pool data
            const poolData = extractPoolData(poolInstance, network)

            //skip if pool is invalid
            if (!poolData || poolData.reserves.some(r => r <= 0n)) {
                console.debug({msg: 'Skipping invalid pool', poolId: contractId})
                return null
            }
            console.debug({msg: 'Pool reserves', poolId: contractId, reserves: [poolData.reserves[0].toString(), poolData.reserves[1].toString()]})
            return poolData
        } catch (err) {
            console.error({msg: 'Error processing pool', poolId: contractId, err})
        }
        return null
    }
}

module.exports = StellarLiquidityPoolProvider