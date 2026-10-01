/**
 * Diagnostic script: compares Aqua stable pool volumes produced by the previous connector version
 * (reserves replaced with [stablePrice, 1]) against the current min-corrected real volumes.
 *
 * Usage: node scripts/compare-stable-volumes.js [rpcUrl] [networkPassphrase]
 *   rpcUrl            defaults to http://localhost:8003
 *   networkPassphrase defaults to pubnet
 */
const RpcConnector = require('../src/rpc-connector')
const {extractAquaPoolData, calculatePrice} = require('../src/pools/aqua/aqua-pool-helper')
const {calculateConcentratedPrice, calculatePoolVolumes} = require('../src/pools/utils')
const {one, fmt, createSimulate, loadAquaPools} = require('./script-utils')

const rpcUrl = process.argv[2] || 'http://localhost:8003'
const network = process.argv[3] || 'Public Global Stellar Network ; September 2015'

/**
 * Load token decimals via contract simulation
 * @param {RpcConnector} rpc - RPC connector
 * @param {string[]} tokens - token contract IDs
 * @return {Promise<Map<string, {decimals: number}>>}
 */
async function loadTokenMeta(rpc, tokens) {
    const simulate = createSimulate(rpc)
    const meta = new Map()
    await Promise.all(tokens.map(token =>
        simulate(token, 'decimals')
            .then(result => meta.set(token, {decimals: Number(result)}))
            .catch(err => console.warn(`Failed to load decimals for ${token}, falling back to default: ${err.message}`))
    ))
    return meta
}

async function main() {
    const pools = await loadAquaPools(['stable', 'concentrated'])
    console.log(`Loaded ${pools.length} stable pools from Aquarius API`)

    const rpc = new RpcConnector([rpcUrl], network)
    const snapshot = await rpc.loadPoolSnapshot(pools.map(p => p.address))
    if (!snapshot)
        throw new Error('Pool read was served at different ledgers - rerun the script')
    const instances = snapshot.instances
    const tokenMeta = await loadTokenMeta(rpc, [...new Set(pools.flatMap(p => p.tokens))])

    const rows = []
    for (const pool of pools) {
        const entry = instances.get(pool.address)
        if (!entry) {
            console.warn(`No contract instance found for pool ${pool.address}`)
            continue
        }
        let poolData
        try {
            poolData = extractAquaPoolData(entry.xdr, tokenMeta)
        } catch (err) {
            console.warn(`Failed to extract pool data for ${pool.address}: ${err.message}`)
            continue
        }
        if (!poolData || !(poolData.stableData || poolData.concentratedData) || poolData.reserves.some(r => r <= 0n))
            continue //skipped identically by both versions
        const pair = poolData.tokens.map(t => pool.symbols.get(t) || t.slice(0, 4)).join('/')
        let price
        try {
            price = poolData.stableData
                ? calculatePrice(poolData.reserves, poolData.stableData)
                : calculateConcentratedPrice(poolData.concentratedData)
        } catch (err) {
            console.warn(`Price calculation failed for ${pool.address} (${pair}): ${err.message}`)
            continue
        }
        //previous version: stable pools became [price, 1], concentrated pools were not supported at all
        const prev = poolData.stableData ? [price, one] : null
        const current = price > 0n ? calculatePoolVolumes(poolData.reserves, price) : null //current version skips unpriceable pools
        rows.push({
            pool: pool.address,
            pair,
            type: pool.type,
            reserves: `${fmt(poolData.reserves[0])} / ${fmt(poolData.reserves[1])}`,
            price: fmt(price),
            prevVolumes: prev ? `${fmt(prev[0])} / ${fmt(prev[1])}` : 'not supported',
            currVolumes: current ? `${fmt(current[0])} / ${fmt(current[1])}` : 'pool skipped',
            //implied price is what the aggregator VWAP yields with base = token1: v1 * 10^14 / v0
            prevImplied: prev ? (price > 0n ? fmt(prev[1] * one / prev[0]) : '— (dropped downstream)') : '—',
            currImplied: current ? fmt(current[1] * one / current[0]) : '—'
        })
    }
    console.table(rows)
    console.log('price/implied columns are token1 per token0; volumes are [token0 slot / token1 slot] at 14 decimals')
}

main()
    .then(() => process.exit(0))
    .catch(err => {
        console.error(err)
        process.exit(1)
    })
