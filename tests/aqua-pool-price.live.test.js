/*eslint-disable no-undef */
const TxCache = require('../src/cache')
const RpcConnector = require('../src/rpc-connector')
const {calculatePrice, extractAquaPoolData} = require('../src/pools/aqua/aqua-pool-helper')
const {adjustPrecision} = require('../src/utils')

const nowSeconds = Math.floor(Date.now() / 1000)

describe('Aqua Pool Provider', () => {
    it('should calculate the correct price', async () => {
        const response = await fetch('https://amm-api.aqua.network/pools/?size=500')
        const data = await response.json()
        const pools = data.items
            .filter(pool => (pool.pool_type === 'constant_product' || pool.pool_type === 'stable') && pool.tokens_str.length === 2)
            .map(pool => ({
                address: pool.address,
                tokens: [[pool.tokens_addresses[0], pool.tokens_str[0]], [pool.tokens_addresses[1], pool.tokens_str[1]]],
                type: pool.pool_type
            }))

        //TODO: load token meta and pass to processPoolInstance
        const res = []
        const rpc = new RpcConnector(['http://localhost:8003'], 'Public Global Stellar Network ; September 2015')
        const cache = new TxCache(rpc)
        await cache.updateTokenMeta([...pools.flatMap(p => [...[p.tokens[0][1], p.tokens[1][1]]]), "CBIJBDNZNF4X35BJ4FFZWCDBSCKOP5NB4PLG4SNENRMLAPYG4P5FM6VN"]) //make sure to include Solv BTC (it has  8 decimals)
        for (const pool of pools) {
            const snapshot = await rpc.loadPoolSnapshot([pool.address])
            if (!snapshot)
                continue
            const poolData = extractAquaPoolData(
                [...snapshot.instances.values()][0].xdr,
                cache.tokensMeta
            )
            if (!poolData)
                continue
            const {reserves, stableData} = poolData
            if (!reserves || reserves[0] === 0n || reserves[1] === 0n) {
                console.debug(`Skipping pool with zero reserves: ${pool.address}`)
                continue
            }
            const one = adjustPrecision(1n, 0) //10^14, the "1.0" sentinel in 14-decimal scale
            const computedPrice = stableData
                ? calculatePrice(reserves, stableData, nowSeconds)
                : reserves[1] * one / reserves[0]
            //in any AMM the side with more reserves is the cheaper one,
            //so price(B per A) must be < 1 iff reserves[0] > reserves[1]
            const aGtB = reserves[0] > reserves[1]
            //pools that returned no price (too shallow) carry no signal here
            const ok = computedPrice === 0n
                ? 'n/a'
                : aGtB === (computedPrice < one) ? true : '!!!'
            res.push({
                address: pool.address,
                tokens: pool.tokens.map(t => t[1].split(':')[0]).join('-'),
                reserves,
                computedPrice,
                ok,
                type: pool.type
            })
        }

        console.table(res)
    }, 60000)
})
