/*eslint-disable class-methods-use-this */
const {encodeAssetContractId} = require('../../utils')
const {calculateConcentratedPrice, calculatePoolVolumes} = require('../utils')
const PoolProviderBase = require('../pool-provider-base')
const PoolType = require('../pool-type')
const {buildGetPoolLedgerKey, parseGetPoolEntry, extractSushiPoolData} = require('./sushi-pool-helper')

/**
 * @typedef {import('../../rpc-connector')} RpcConnector
 */

//fee tiers enabled on the SushiSwap V3 factory (hundredths of a bip)
const FEE_TIERS = [100, 500, 3000, 10000]

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
     * @return {Promise<string[]>}
     */
    async getTargetPools(baseAsset, assets, network) {
        try {
            const rpc = this.__rpcConnectors.get(network)
            if (!rpc) {
                console.warn({msg: 'SushiSwap pool provider is not configured with an RPC connector', network})
                return []
            }
            const baseToken = encodeAssetContractId(baseAsset, network)
            const keys = []
            for (const asset of assets) {
                const token = encodeAssetContractId(asset, network)
                if (token === baseToken)
                    continue
                for (const fee of FEE_TIERS) {
                    //the factory stores both orderings for every pool
                    keys.push(buildGetPoolLedgerKey(baseToken, token, fee))
                    keys.push(buildGetPoolLedgerKey(token, baseToken, fee))
                }
            }
            if (keys.length === 0)
                return []
            const {entries} = await rpc.loadLedgerEntries(keys)
            const pools = new Set()
            for (const entry of entries) {
                pools.add(parseGetPoolEntry(entry.xdr))
            }
            const targetPools = [...pools]
            console.debug({msg: 'Pools found', baseAsset: baseToken, pools: targetPools})
            return targetPools
        } catch (err) {
            console.error({msg: `Error loading pool list for ${this.constructor.name} provider`, err})
            return []
        }
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
