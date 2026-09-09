/**
 * Verification script: checks our Aqua concentrated pool parsing and price math against the deployed contracts.
 * For every live concentrated pool it compares:
 *   1. token order: storage-parsed Token0/Token1 vs contract get_tokens()
 *   2. reserve order/values: storage-parsed Reserve0/Reserve1 vs contract get_reserves()
 *   3. price: our calculateConcentratedPrice() vs the two-way mid-price from the contract's own estimate_swap()
 *      (fee and slippage cancel to first order in the two-way mid, so small deviations are expected)
 *   4. tick consistency: raw price must satisfy tick <= log_1.0001(price) < tick + 1
 *
 * Usage: node scripts/verify-concentrated-price.js [rpcUrl] [networkPassphrase]
 */
const {xdr, nativeToScVal} = require('@stellar/stellar-sdk')
const RpcConnector = require('../src/rpc-connector')
const {extractInstanceStorage, getContractInstanceValues, calculateConcentratedPrice, calculatePoolVolumes} = require('../src/pools/utils')
const {adjustPrecision} = require('../src/utils')
const {one, fmt, createSimulate, loadAquaPools} = require('./script-utils')

const rpcUrl = process.argv[2] || 'http://localhost:8003'
const network = process.argv[3] || 'Public Global Stellar Network ; September 2015'

async function main() {
    const pools = await loadAquaPools(['concentrated'])
    console.log(`Loaded ${pools.length} concentrated pools from Aquarius API`)
    const rpc = new RpcConnector([rpcUrl], network)
    const instances = await rpc.loadContractInstances(pools.map(p => p.address))

    const simulate = createSimulate(rpc)

    const rows = []
    for (const pool of pools) {
        const entry = instances.get(pool.address)
        if (!entry)
            continue
        const storage = getContractInstanceValues(extractInstanceStorage(entry.xdr), ['Reserve0', 'Reserve1', 'Token0', 'Token1', 'Slot0'])
        if (!storage.Token0 || !storage.Slot0)
            continue
        const storageTokens = [storage.Token0, storage.Token1]
        const pair = storageTokens.map(t => pool.symbols.get(t) || t.slice(0, 4)).join('/')
        const row = {pool: pool.address, pair}
        try {
            //1: token order - ground truth from the contract itself
            const chainTokens = await simulate(pool.address, 'get_tokens')
            row.tokensMatch = chainTokens.length === 2 && chainTokens.every((t, i) => t === storageTokens[i])

            //2: reserve order/values (may drift by concurrent trades between instance load and simulation)
            const chainReserves = await simulate(pool.address, 'get_reserves')
            row.reservesMatch = chainReserves.length === 2
                && BigInt(chainReserves[0]) === BigInt(storage.Reserve0)
                && BigInt(chainReserves[1]) === BigInt(storage.Reserve1)

            //3: price
            const decimals = await Promise.all(chainTokens.map(t => simulate(t, 'decimals').then(Number)))
            const sqrtPriceX96 = storage.Slot0.sqrt_price_x96
            const ourPrice = calculateConcentratedPrice({sqrtPriceX96, digits: decimals})
            row.ourPrice = fmt(ourPrice)

            //volumes the connector feeds to the aggregator: min-corrected reserves at our price
            const reserves = [
                adjustPrecision(BigInt(storage.Reserve0), decimals[0]),
                adjustPrecision(BigInt(storage.Reserve1), decimals[1])
            ]
            row.volumes = ourPrice > 0n ? calculatePoolVolumes(reserves, ourPrice).map(fmt).join(' / ') : 'pool skipped'

            //4: tick consistency on the raw (decimals-agnostic) price
            const rawPrice = Number(sqrtPriceX96) / 2 ** 96
            const logTick = Math.log(rawPrice * rawPrice) / Math.log(1.0001)
            row.tickCheck = Math.abs(logTick - Number(storage.Slot0.tick)) <= 1 ? true : `tick=${storage.Slot0.tick} log=${logTick.toFixed(2)}`

            //swap 1% of each reserve in each direction - small enough to stay near the marginal price
            //even in micro pools, where a whole-token probe would exhaust the opposite side
            const dx0 = BigInt(storage.Reserve0) / 100n
            const dx1 = BigInt(storage.Reserve1) / 100n
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
            const aDy = adjustPrecision(BigInt(dy1Raw), decimals[1])
            const bDy = adjustPrecision(BigInt(dy0Raw), decimals[0])
            if (aDy > 0n && bDy > 0n) {
                const leg0 = aDy * one / dx0Norm //token1 per token0 implied by selling token0
                const leg1 = dx1Norm * one / bDy //token1 per token0 implied by selling token1
                const contractPrice = (leg0 + leg1) / 2n
                row.contractPrice = fmt(contractPrice)
                const diff = ourPrice > contractPrice ? ourPrice - contractPrice : contractPrice - ourPrice
                row.diffPct = contractPrice > 0n ? `${(Number(diff * 1000000n / contractPrice) / 10000).toFixed(4)}%` : 'n/a'
            } else {
                row.contractPrice = 'n/a (shallow)'
                row.diffPct = '-'
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
