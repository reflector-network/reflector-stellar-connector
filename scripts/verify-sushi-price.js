/**
 * Verification script: checks our SushiSwap pool parsing, key construction and price math
 * against the deployed contracts. For every live pool it compares:
 *   1. GetPool key construction: our buildGetPoolLedgerKey vs the actual factory state keys
 *   2. token order: storage-parsed params.token0/token1 vs contract get_tokens-equivalent (factory key tokens)
 *   3. price: our calculateConcentratedPrice vs the pool's own quote_exact_input two-way mid (1% probes)
 *   4. tick consistency: raw price must match 1.0001^tick
 *
 * Usage: node scripts/verify-sushi-price.js [rpcUrl] [networkPassphrase]
 */
const {xdr, nativeToScVal, scValToNative} = require('@stellar/stellar-sdk')
const RpcConnector = require('../src/rpc-connector')
const {extractInstanceStorage, calculateConcentratedPrice, calculatePoolVolumes} = require('../src/pools/utils')
const {buildGetPoolLedgerKey, extractSushiPoolData, SUSHI_FACTORY} = require('../src/pools/sushi/sushi-pool-helper')
const {adjustPrecision} = require('../src/utils')
const {one, fmt, createSimulate} = require('./script-utils')

//sqrt price limits from Uniswap V3 (swap direction bounds)
const MIN_SQRT_RATIO = 4295128739n
const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n

const rpcUrl = process.argv[2] || 'http://localhost:8003'
const network = process.argv[3] || 'Public Global Stellar Network ; September 2015'

/**Enumerate factory GetPool records via the stellar.expert contract-state API (pages may repeat rows; stop on an empty page) */
async function loadFactoryPools() {
    const base = `https://api.stellar.expert/explorer/public/contract-state/${SUSHI_FACTORY}`
    let url = `${base}?durability=persistent&order=desc&limit=200`
    const byPool = new Map()
    while (url) {
        const data = await fetch(url).then(res => res.json())
        const page = data._embedded?.records || []
        if (page.length === 0)
            break
        for (const record of page) {
            let parsed
            try {
                parsed = scValToNative(xdr.ScVal.fromXdr(record.key, 'base64'))
            } catch {
                continue
            }
            if (!Array.isArray(parsed) || parsed[0] !== 'GetPool')
                continue
            const [, token0, token1, fee] = parsed
            const pool = scValToNative(xdr.ScVal.fromXdr(record.value, 'base64'))
            if (!byPool.has(pool))
                byPool.set(pool, {pool, token0, token1, fee: Number(fee), rawKey: record.key})
        }
        const next = data._links?.next?.href
        url = next ? `https://api.stellar.expert${next}` : null
    }
    return [...byPool.values()]
}

async function main() {
    const pools = await loadFactoryPools()
    console.log(`Discovered ${pools.length} SushiSwap pools from factory state`)
    const rpc = new RpcConnector([rpcUrl], network)
    const instances = await rpc.loadContractInstances(pools.map(p => p.pool))

    const simulate = createSimulate(rpc)

    const rows = []
    for (const item of pools) {
        const row = {pool: item.pool, fee: item.fee}
        //1: our key construction must reproduce the actual factory state key (inner ScVal comparison)
        const ourKey = xdr.LedgerKey.fromXdr(buildGetPoolLedgerKey(item.token0, item.token1, item.fee), 'base64')
        row.keyMatch = ourKey.value.key.toXdr('base64') === item.rawKey
        const entry = instances.get(item.pool)
        if (!entry) {
            row.error = 'no instance'
            rows.push(row)
            continue
        }
        try {
            const decimals = await Promise.all([item.token0, item.token1].map(t => simulate(t, 'decimals').then(Number)))
            row.decimals = decimals.join('/')
            const tokenMeta = new Map([item.token0, item.token1].map((t, i) => [t, {decimals: decimals[i]}]))
            const poolData = extractSushiPoolData(entry.xdr, tokenMeta)
            if (!poolData) {
                row.error = 'extract failed'
                rows.push(row)
                continue
            }
            //2: the factory key tokens must match the instance params token set (order may be the reverse key)
            row.tokensMatch = new Set([item.token0, item.token1, ...poolData.tokens]).size === 2

            const ourPrice = calculateConcentratedPrice(poolData.concentratedData)
            row.ourPrice = fmt(ourPrice)
            row.volumes = ourPrice > 0n ? calculatePoolVolumes(poolData.reserves, ourPrice).map(fmt).join(' / ') : 'pool skipped'

            //4: tick consistency on the raw (decimals-agnostic) price
            const storage = extractInstanceStorage(entry.xdr).value.val.instance
            let tick = null
            for (const kv of storage.storage) {
                if (scValToNative(kv.key) === 'pstate') {
                    tick = Number(scValToNative(kv.val).slot0.tick)
                }
            }
            const rawPrice = Number(poolData.concentratedData.sqrtPriceX96) / 2 ** 96
            const logTick = Math.log(rawPrice * rawPrice) / Math.log(1.0001)
            row.tickCheck = tick !== null && Math.abs(logTick - tick) <= 1 ? true : `tick=${tick} log=${logTick.toFixed(2)}`

            //3: price vs the pool's own quote_exact_input, probing 1% of each raw balance
            const rawBalances = poolData.reserves.map((r, i) => adjustPrecision(r, 14, decimals[i]))
            const dx0 = rawBalances[0] / 100n
            const dx1 = rawBalances[1] / 100n
            if (dx0 === 0n || dx1 === 0n) {
                row.contractPrice = 'n/a (dust)'
                rows.push(row)
                continue
            }
            const i128 = v => nativeToScVal(v, {type: 'i128'})
            const u256 = v => nativeToScVal(v, {type: 'u256'})
            const boolVal = v => nativeToScVal(v, {type: 'bool'})
            const res01 = await simulate(item.pool, 'quote_exact_input', [boolVal(true), i128(dx0), u256(MIN_SQRT_RATIO + 1n)])
            const res10 = await simulate(item.pool, 'quote_exact_input', [boolVal(false), i128(dx1), u256(MAX_SQRT_RATIO - 1n)])
            const dy1 = -BigInt(res01.amount1) //token1 paid out for the token0 probe
            const dy0 = -BigInt(res10.amount0) //token0 paid out for the token1 probe
            if (dy1 > 0n && dy0 > 0n) {
                const dx0Norm = adjustPrecision(dx0, decimals[0])
                const dx1Norm = adjustPrecision(dx1, decimals[1])
                const leg0 = adjustPrecision(dy1, decimals[1]) * one / dx0Norm //token1 per token0 selling token0
                const leg1 = dx1Norm * one / adjustPrecision(dy0, decimals[0]) //token1 per token0 selling token1
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
    console.log('prices are token1 per token0; contractPrice is rebuilt from the pool\'s own quote_exact_input() both ways')
}

main()
    .then(() => process.exit(0))
    .catch(err => {
        console.error(err)
        process.exit(1)
    })
