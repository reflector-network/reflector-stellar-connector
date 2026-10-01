/*eslint-disable class-methods-use-this */
const {StrKey} = require('@stellar/stellar-sdk')
const {encodeAssetContractId} = require('../../utils')
const {calculateConcentratedPrice, calculatePoolVolumes} = require('../utils')
const PoolProviderBase = require('../pool-provider-base')
const PoolType = require('../pool-type')
const {buildGetPoolLedgerKey, parseGetPoolEntry, extractSushiPoolData, SUSHI_FACTORY} = require('./sushi-pool-helper')

/**
 * @typedef {import('../../rpc-connector')} RpcConnector
 */

//fee tiers enabled on the SushiSwap V3 factory (hundredths of a bip)
const FEE_TIERS = [100, 500, 3000, 10000]

/**
 * @param {string} [value] - the data source's factoryContract
 * @return {string} the factory to look pools up in; the default when unset
 */
function resolveFactory(value) {
    if (value === undefined || value === null)
        return SUSHI_FACTORY
    if (typeof value !== 'string' || !StrKey.isValidContract(value))
        throw new Error('SushiSwap provider setting factoryContract must be a contract id')
    return value
}

class SushiPoolProvider extends PoolProviderBase {

    /**
     * RPC connectors for factory pool lookups, keyed by network passphrase.
     * The provider instance is shared between data sources, so every network keeps its own connector
     * @type {Map<string, RpcConnector>}
     * @private
     */
    __rpcConnectors = new Map()

    /**
     * Register the RPC connector used for factory pool lookups on the connector's network
     * @param {RpcConnector} rpcConnector - RPC connector instance
     */
    configure(rpcConnector) {
        this.__rpcConnectors.set(rpcConnector.network, rpcConnector)
    }

    /**
     * Get pool type
     * @return {string}
     */
    get type() {
        return PoolType.SUSHISWAP
    }

    /**
     * Discover SushiSwap pools pairing the base asset with tracked assets via factory GetPool lookups
     * @param {string} baseAsset - oracle base token
     * @param {string[]} assets - tracked assets
     * @param {string} network - network passphrase
     * @param {{factoryContract: string}} [settings] - provider settings from the data source; unset means the default factory
     * @return {Promise<Map<string, string[]>>} pool ids per asset; rejects when the lookup fails
     */
    async getTargetPools(baseAsset, assets, network, settings = {}) {
        const result = new Map(assets.map(asset => [asset, []]))
        const factory = resolveFactory(settings.factoryContract)
        const rpc = this.__rpcConnectors.get(network)
        if (!rpc)
            throw new Error('SushiSwap pool provider is not configured with an RPC connector')
        const baseToken = encodeAssetContractId(baseAsset, network)
        const assetsByToken = new Map()
        const keys = []
        for (const asset of assets) {
            let token = null
            try {
                token = encodeAssetContractId(asset, network)
            } catch (err) {
                //an asset with no contract id has no SushiSwap pool, and must not fail the lookup of the others
                console.warn({msg: 'Skipping SushiSwap pair', baseAsset, asset, network, err: err.message})
                continue
            }
            if (token === baseToken)
                continue
            assetsByToken.set(token, asset)
            for (const fee of FEE_TIERS) {
                //the factory stores both orderings for every pool
                keys.push(buildGetPoolLedgerKey(baseToken, token, fee, factory))
                keys.push(buildGetPoolLedgerKey(token, baseToken, fee, factory))
            }
        }
        if (keys.length === 0)
            return result
        //a failed lookup rejects: the caller must not read it as "no pools"
        const {entries} = await rpc.loadLedgerEntries(keys)
        for (const entry of entries) {
            const {pool, tokens} = parseGetPoolEntry(entry.xdr)
            if (tokens.length !== 2) {
                console.debug({msg: 'Skipping pool with invalid token count', poolId: pool, tokens})
                continue //tokens length is not 2
            }
            const baseAssetIndex = tokens.indexOf(baseToken)
            if (baseAssetIndex === -1) {
                console.debug({msg: 'Skipping pool with no base asset', poolId: pool, tokens})
                continue //base asset is not part of this pool
            }
            const asset = assetsByToken.get(tokens[1 - baseAssetIndex])
            if (!asset) {
                console.debug({msg: 'Skipping pool with no matching asset', poolId: pool, tokens})
                continue //a pair this call did not ask for
            }
            const pools = result.get(asset)
            if (!pools.includes(pool))
                pools.push(pool)
        }
        console.debug({msg: 'Pools found', baseAsset: baseToken, pools: Object.fromEntries(result)})
        return result
    }

    /**
     * @param {string} poolInstance - pool data instance in XDR format
     * @param {string} contractId - pool contract id
     * @param {string} network - network passphrase
     * @param {Map<string, {decimals: number}>} tokenMeta - Metadata for tokens to aggregate pools data for
     * @param {number} lastModifiedLedger - pool's last-modified ledger seq
     * @return {{reserves: BigInt[], tokens: string[]}|null} - pool volumes and tokens or null if the pool is invalid
     */
    processPoolInstance(poolInstance, contractId, network, tokenMeta, lastModifiedLedger) {
        try {
            const poolData = extractSushiPoolData(poolInstance, tokenMeta)
            if (!poolData || poolData.reserves.some(r => r <= 0n)) {
                console.debug({msg: 'Skipping invalid pool', poolId: contractId, lastModifiedLedger})
                return null
            }
            const rawReserves = [poolData.reserves[0].toString(), poolData.reserves[1].toString()]
            const price = calculateConcentratedPrice(poolData.concentratedData)
            if (price <= 0n) { //pool uninitialized - no signal
                console.debug({msg: 'Skipping pool with no computable price', poolId: contractId, rawReserves, lastModifiedLedger})
                return null
            }
            poolData.reserves = calculatePoolVolumes(poolData.reserves, price)
            //single consolidated entry with everything needed to reconstruct how the pool volumes were formed
            console.debug({
                msg: 'Pool data processed',
                poolId: contractId,
                kind: 'concentrated',
                rawReserves,
                price: price.toString(),
                sqrtPriceX96: poolData.concentratedData.sqrtPriceX96.toString(),
                digits: poolData.concentratedData.digits,
                volumes: [poolData.reserves[0].toString(), poolData.reserves[1].toString()],
                lastModifiedLedger
            })
            return {reserves: poolData.reserves, tokens: poolData.tokens}
        } catch (err) {
            console.error({msg: 'Error processing pool', poolId: contractId, err})
        }
        return null
    }
}

module.exports = SushiPoolProvider
