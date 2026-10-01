/**
 * Verification script: checks our Aqua stable pool parsing and price math against the deployed contracts.
 * For every live stable pool it compares:
 *   1. token order: storage-parsed Tokens vs contract get_tokens()
 *   2. reserve order/values: storage-parsed Reserves vs contract get_reserves()
 *   3. decimals order: storage-parsed Decimals vs each token's decimals()
 *   4. price: our calculatePrice() vs the same two-way mid-price computed from the contract's own estimate_swap()
 *
 * Usage: node scripts/verify-stable-price.js [rpcUrl] [networkPassphrase]
 */
const {xdr, nativeToScVal} = require('@stellar/stellar-sdk')
const RpcConnector = require('../src/rpc-connector')
const {extractAquaPoolData, calculatePrice} = require('../src/pools/aqua/aqua-pool-helper')
const {extractInstanceStorage, getContractInstanceValues, calculatePoolVolumes} = require('../src/pools/utils')
const {adjustPrecision} = require('../src/utils')
const {one, fmt, createSimulate, loadAquaPools} = require('./script-utils')

const rpcUrl = process.argv[2] || 'http://localhost:8003'
const network = process.argv[3] || 'Public Global Stellar Network ; September 2015'

async function main() {
    const pools = await loadAquaPools(['stable'])
    console.log(`Loaded ${pools.length} stable pools from Aquarius API`)
    const rpc = new RpcConnector([rpcUrl], network)
    const snapshot = await rpc.loadPoolSnapshot(pools.map(p => p.address))
    if (!snapshot)
        throw new Error('Pool read was served at different ledgers - rerun the script')
    const instances = snapshot.instances

    const simulate = createSimulate(rpc)

    const rows = []
    for (const pool of pools) {
        const entry = instances.get(pool.address)
        if (!entry)
            continue
        //raw storage as our code parses it
        const storage = getContractInstanceValues(extractInstanceStorage(entry.xdr), ['Reserves', 'Decimals', 'Tokens', 'InitialA', 'InitialATime', 'FutureA', 'FutureATime', 'Fee'])
        if (!storage.Tokens || !storage.Reserves)
            continue
        const pair = storage.Tokens.map(t => pool.symbols.get(t) || t.slice(0, 4)).join('/')
        const row = {pool: pool.address, pair}
        try {
            //1: token order - ground truth from the contract itself
            const chainTokens = await simulate(pool.address, 'get_tokens')
            row.tokensMatch = chainTokens.length === 2 && chainTokens.every((t, i) => t === storage.Tokens[i])

            //2: reserve order/values (may drift by concurrent trades between instance load and simulation)
            const chainReserves = await simulate(pool.address, 'get_reserves')
            row.reservesMatch = chainReserves.length === 2 && chainReserves.every((r, i) => BigInt(r) === BigInt(storage.Reserves[i]))

            //3: decimals order
            const chainDecimals = await Promise.all(chainTokens.map(t => simulate(t, 'decimals')))
            row.decimalsMatch = storage.Decimals === undefined
                ? 'n/a (no Decimals key)'
                : chainDecimals.every((d, i) => Number(d) === Number(storage.Decimals[i]))

            //4: price - our full pipeline vs the contract's own swap estimator
            const decimals = storage.Decimals ? storage.Decimals.map(Number) : chainDecimals.map(Number)
            const poolData = extractAquaPoolData(entry.xdr, new Map(chainTokens.map((t, i) => [t, {decimals: decimals[i]}])))
            const ourPrice = calculatePrice(poolData.reserves, poolData.stableData)
            row.ourPrice = fmt(ourPrice)

            //volumes the connector feeds to the aggregator: min-corrected reserves at our price
            row.volumes = ourPrice > 0n ? calculatePoolVolumes(poolData.reserves, ourPrice).map(fmt).join(' / ') : 'pool skipped'

            //probe the contract with 1% of the smaller reserve, mirroring calculatePrice's proportional probe
            const probe = (poolData.reserves[0] < poolData.reserves[1] ? poolData.reserves[0] : poolData.reserves[1]) / 100n
            const dx0 = adjustPrecision(probe, 14, decimals[0]) //probe restated in each token's raw units
            const dx1 = adjustPrecision(probe, 14, decimals[1])
            if (dx0 === 0n || dx1 === 0n) {
                row.contractPrice = 'n/a (dust)'
                row.diffPct = '-'
                rows.push(row)
                continue
            }
            const u32 = v => xdr.ScVal.scvU32(v)
            const u128 = v => nativeToScVal(v, {type: 'u128'})
            const dy1Raw = await simulate(pool.address, 'estimate_swap', [u32(0), u32(1), u128(dx0)])
            const dy0Raw = await simulate(pool.address, 'estimate_swap', [u32(1), u32(0), u128(dx1)])
            const dx0Norm = adjustPrecision(dx0, decimals[0])
            const dx1Norm = adjustPrecision(dx1, decimals[1])
            const aDy = adjustPrecision(BigInt(dy1Raw), decimals[1]) //token1 received for the token0 probe
            const bDy = adjustPrecision(BigInt(dy0Raw), decimals[0]) //token0 received for the token1 probe
            if (aDy > 0n && bDy > 0n) {
                const leg0 = aDy * one / dx0Norm //token1 per token0 implied by selling token0
                const leg1 = dx1Norm * one / bDy //token1 per token0 implied by selling token1
                const contractPrice = (leg0 + leg1) / 2n //same two-way mid as calculatePrice
                row.contractPrice = fmt(contractPrice)
                const diff = ourPrice > contractPrice ? ourPrice - contractPrice : contractPrice - ourPrice
                row.diffPct = contractPrice > 0n ? `${(Number(diff * 1000000n / contractPrice) / 10000).toFixed(4)}%` : 'n/a'
            } else {
                row.contractPrice = 'n/a (shallow)'
                row.diffPct = ourPrice === 0n ? 'both zero' : 'MISMATCH: we priced it'
            }
        } catch (err) {
            row.error = err.message.slice(0, 80)
        }
        rows.push(row)
    }
    console.table(rows)
    console.log('prices are token1 per token0; contractPrice is rebuilt from the pool\'s own estimate_swap() both ways')
}

main()
    .then(() => process.exit(0))
    .catch(err => {
        console.error(err)
        process.exit(1)
    })
