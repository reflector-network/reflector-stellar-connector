/*eslint-disable no-undef */
const TxCache = require('../src/cache')
const {calculatePrice, extractAquaPoolData} = require('../src/pools/aqua-pool-helper')
const RpcConnector = require('../src/rpc-connector')
const {TARGET_DECIMALS, adjustPrecision} = require('../src/utils')


function spotPriceLinear([x, y], idxIn = 0, amp) {
    const delta = idxIn === 0 ? x - y : y - x
    const S = x + y
    return 1 + delta * 2 / (S * amp)
}

function spotPriceLinearFee(balances, idxIn = 0, A = 1500n, feeBp = 1n) {
    const [x, y] = balances
    const delta = idxIn === 0 ? x - y : y - x
    const sum = x + y
    const feeKoef = 1 - Number(feeBp) / 10_000
    const price = 1 + Number(delta) * 2 / (Number(sum) * Number(A))
    return price * feeKoef
}

describe('calculatePrice with BigInt stableData', () => {
    const reserves = [1000000000000000000n, 1000000000000000000n] //equal reserves, 18-digit precision

    it('should return a price when futureATime is in the past (early return path)', () => {
        const pastTimestamp = BigInt(Math.floor(Date.now() / 1000) - 3600) //1 hour ago
        const stableData = {
            initialA: 1000n,
            initialATime: pastTimestamp - 7200n, //3 hours ago
            futureA: 1500n,
            futureATime: pastTimestamp, //1 hour ago — triggers early return of futureA
            fee: 30n
        }
        const price = calculatePrice(reserves, stableData)
        expect(typeof price).toBe('bigint')
        expect(price).toBeGreaterThan(0n)
    })

    it('should return a price when A is actively ramping (interpolation path)', () => {
        const now = BigInt(Math.floor(Date.now() / 1000))
        const stableData = {
            initialA: 1000n,
            initialATime: now - 3600n, //started 1 hour ago
            futureA: 2000n,
            futureATime: now + 3600n, //ends 1 hour from now — forces interpolation
            fee: 30n
        }
        const price = calculatePrice(reserves, stableData)
        expect(typeof price).toBe('bigint')
        expect(price).toBeGreaterThan(0n)
    })

    it('should return a price when A is ramping down', () => {
        const now = BigInt(Math.floor(Date.now() / 1000))
        const stableData = {
            initialA: 2000n,
            initialATime: now - 3600n,
            futureA: 1000n,
            futureATime: now + 3600n,
            fee: 30n
        }
        const price = calculatePrice(reserves, stableData)
        expect(typeof price).toBe('bigint')
        expect(price).toBeGreaterThan(0n)
    })

    it('should not throw TypeError when mixing BigInt timestamps with amplification values', () => {
        const now = BigInt(Math.floor(Date.now() / 1000))
        const stableData = {
            initialA: 500n,
            initialATime: now - 1000n,
            futureA: 1500n,
            futureATime: now + 1000n,
            fee: 1n
        }
        //this would throw "Cannot mix BigInt and other types" before the fix
        expect(() => calculatePrice(reserves, stableData)).not.toThrow()
    })

    it('should produce consistent prices for equal reserves regardless of A value', () => {
        const pastTimestamp = BigInt(Math.floor(Date.now() / 1000) - 3600)
        //with equal reserves, a stable pool should price near 1:1 regardless of A
        const priceA = calculatePrice(reserves, {
            initialA: 500n,
            initialATime: pastTimestamp - 7200n,
            futureA: 500n,
            futureATime: pastTimestamp,
            fee: 0n
        })
        const priceB = calculatePrice(reserves, {
            initialA: 5000n,
            initialATime: pastTimestamp - 7200n,
            futureA: 5000n,
            futureATime: pastTimestamp,
            fee: 0n
        })
        //both prices should be close to 10^14 (1:1 in 14-decimal representation)
        const target = 10n ** 14n
        const tolerance = target / 100n //1% tolerance
        expect(priceA).toBeGreaterThan(target - tolerance)
        expect(priceA).toBeLessThan(target + tolerance)
        expect(priceB).toBeGreaterThan(target - tolerance)
        expect(priceB).toBeLessThan(target + tolerance)
    })
})

describe.skip('Aqua Pool Provider', () => {
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
            const poolInstances = await rpc.loadContractInstances([pool.address])
            const poolData = extractAquaPoolData(
                [...poolInstances.values()][0].xdr,
                cache.tokensMeta
            )
            if (!poolData)
                continue
            const {reserves, tokens, stableData} = poolData
            if (!reserves || reserves[0] === 0n || reserves[1] === 0n) {
                console.debug(`Skipping pool with zero reserves: ${pool.address}`)
                continue
            }
            const originalReserves = reserves
            if (stableData) {
                reserves[0] = calculatePrice(poolData.reserves, poolData.stableData)
                reserves[1] = adjustPrecision(1n, 0)
            }
            const aGtB = originalReserves[0] > originalReserves[1]
            res.push({
                address: pool.address,
                tokens: pool.tokens.map(t => t[1].split(':')[0]).join('-'),
                originalReserves,
                reserves,
                computedPrice: reserves[0] * adjustPrecision(1n, 0) / reserves[1],
                is: aGtB === reserves[0] > reserves[1] ? aGtB : '!!!',
                type: pool.type
            })
        }

        console.table(res)
    }, 60000)
})