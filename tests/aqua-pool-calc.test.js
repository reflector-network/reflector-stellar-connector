/*eslint-disable no-undef */
const TxCache = require('../src/cache')
const {calculatePrice, extractAquaPoolData} = require('../src/pools/aqua/aqua-pool-helper')
const {calculatePoolVolumes, calculateConcentratedPrice} = require('../src/pools/utils')
const RpcConnector = require('../src/rpc-connector')
const {TARGET_DECIMALS, adjustPrecision} = require('../src/utils')

const nowSeconds = Math.floor(Date.now() / 1000)

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
        const price = calculatePrice(reserves, stableData, nowSeconds)
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
        const price = calculatePrice(reserves, stableData, nowSeconds)
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
        const price = calculatePrice(reserves, stableData, nowSeconds)
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
        expect(() => calculatePrice(reserves, stableData, nowSeconds)).not.toThrow()
    })

    it('probes proportionally to pool depth, so the price does not depend on pool scale', () => {
        const pastTimestamp = BigInt(Math.floor(Date.now() / 1000) - 3600)
        const stableData = {
            initialA: 10n, //low amplification so probe-size slippage would be visible
            initialATime: pastTimestamp - 7200n,
            futureA: 10n,
            futureATime: pastTimestamp,
            fee: 0n
        }
        const small = [2n * 10n ** 14n, 8n * 10n ** 14n] //2 / 8 tokens - shallow, so probe-size slippage would show up here
        const large = [2n * 10n ** 20n, 8n * 10n ** 20n] //2M / 8M tokens - same shape, deep
        const priceSmall = calculatePrice(small, stableData, nowSeconds)
        const priceLarge = calculatePrice(large, stableData, nowSeconds)
        //stableswap is scale-homogeneous, so both pools must price identically (0.1% tolerance for integer rounding)
        const diff = priceSmall > priceLarge ? priceSmall - priceLarge : priceLarge - priceSmall
        expect(diff).toBeLessThan(priceLarge / 1000n)
        //and both must sit at the marginal price for this pool shape
        const marginal = 124980541019954n
        const drift = priceLarge > marginal ? priceLarge - marginal : marginal - priceLarge
        expect(drift).toBeLessThan(marginal / 1000n)
    })

    it('returns zero when reserves are too small to derive a probe', () => {
        const pastTimestamp = BigInt(Math.floor(Date.now() / 1000) - 3600)
        const stableData = {
            initialA: 100n,
            initialATime: pastTimestamp - 7200n,
            futureA: 100n,
            futureATime: pastTimestamp,
            fee: 0n
        }
        expect(calculatePrice([50n, 50n], stableData, nowSeconds)).toBe(0n)
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
        }, nowSeconds)
        const priceB = calculatePrice(reserves, {
            initialA: 5000n,
            initialATime: pastTimestamp - 7200n,
            futureA: 5000n,
            futureATime: pastTimestamp,
            fee: 0n
        }, nowSeconds)
        //both prices should be close to 10^14 (1:1 in 14-decimal representation)
        const target = 10n ** 14n
        const tolerance = target / 100n //1% tolerance
        expect(priceA).toBeGreaterThan(target - tolerance)
        expect(priceA).toBeLessThan(target + tolerance)
        expect(priceB).toBeGreaterThan(target - tolerance)
        expect(priceB).toBeLessThan(target + tolerance)
    })
})

describe('calculatePoolVolumes', () => {
    const one = adjustPrecision(1n, 0) //10^14

    it('caps volumes by the token0 side when it is worth less than the token1 reserve', () => {
        //30,836.271869 USDT0 vs 40,006.7906103 USDC at price 1.001 (token1 per token0)
        const reserves = [3083627186900000000n, 4000679061030000000n]
        const price = 100100000000000n //1.001
        expect(calculatePoolVolumes(reserves, price)).toEqual([
            3083627186900000000n, //token0 reserve kept as-is (the scarcer side)
            3086710814086900000n //its value in token1 terms: 30,867.108140869
        ])
    })

    it('caps volumes by the token1 reserve when it is the smaller side', () => {
        //40,000 token0 vs 30,000 token1 at price 0.999 - token0 side is worth 39,960 token1, so token1 caps
        const reserves = [4000000000000000000n, 3000000000000000000n]
        const price = 99900000000000n //0.999
        expect(calculatePoolVolumes(reserves, price)).toEqual([
            3003003003003003003n, //token1 reserve converted to token0 terms: 30,030.03003...
            3000000000000000000n //token1 reserve kept as-is
        ])
    })

    it('keeps both sides untouched when they are worth exactly the same', () => {
        const reserves = [1000000000000000000n, 2000000000000000000n]
        const price = 2n * one //2.0
        expect(calculatePoolVolumes(reserves, price)).toEqual([1000000000000000000n, 2000000000000000000n])
    })

    it('yields the stable price when volumes are fed to VWAP', () => {
        const reserves = [3083627186900000000n, 4000679061030000000n]
        const price = 100100000000000n
        const [v0, v1] = calculatePoolVolumes(reserves, price)
        //with base = token1 the aggregator computes v1 * 10^14 / v0 = token1 per token0, i.e. the stable price
        expect(v1 * one / v0).toBe(price)
    })
})

describe('calculateConcentratedPrice', () => {
    it('derives the price from sqrt_price_x96 captured from a live pool', () => {
        //USDT0/USDC pool CCJH…6HSQ: tick 4, so the price must be ≈1.0001^4 ≈ 1.0004
        const price = calculateConcentratedPrice({sqrtPriceX96: 79246271960821347022979480869n, digits: [7, 7]})
        expect(price).toBe(100045719894670n) //1.00045719894670 token1 per token0
    })

    it('returns 1:1 raw price adjusted for differing token decimals', () => {
        //sqrtPriceX96 = 2^96 means raw price 1.0; token1 has one decimal more, so human price is 0.1
        const price = calculateConcentratedPrice({sqrtPriceX96: 2n ** 96n, digits: [7, 8]})
        expect(price).toBe(10000000000000n) //0.1 at 14 decimals
    })

    it('squares the sqrt price ratio', () => {
        //sqrtPriceX96 = 2 * 2^96 means sqrt(price) = 2, so price = 4
        const price = calculateConcentratedPrice({sqrtPriceX96: 2n ** 97n, digits: [7, 7]})
        expect(price).toBe(400000000000000n) //4.0 at 14 decimals
    })

    it('returns zero for uninitialized sqrt price', () => {
        expect(calculateConcentratedPrice({sqrtPriceX96: 0n, digits: [7, 7]})).toBe(0n)
    })
})

describe('extractAquaPoolData for concentrated pools', () => {
    const concentratedPoolFixture = require('./fixtures/concentrated-pool-instance.json')

    it('extracts tokens, reserves and concentrated data from a live instance snapshot', () => {
        const tokenMeta = new Map([
            ['CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF', {decimals: 7}],
            ['CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75', {decimals: 7}]
        ])
        const poolData = extractAquaPoolData(concentratedPoolFixture.xdr, tokenMeta)
        expect(poolData.tokens).toEqual([
            'CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF', //USDT0
            'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75' //USDC
        ])
        expect(poolData.reserves).toEqual([3398582110570000000n, 3710021060590000000n]) //raw 7-decimals reserves at 14 decimals
        expect(poolData.stableData).toBeUndefined()
        expect(poolData.concentratedData).toEqual({sqrtPriceX96: 79246271960821347022979480869n, digits: [7, 7]})
    })

    it('returns null when token metadata failed to load', () => {
        //updateTokenMeta stores {failedAt} without decimals when the on-chain decimals() call fails
        const tokenMeta = new Map([
            ['CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF', {decimals: 7}],
            ['CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75', {failedAt: Date.now()}]
        ])
        expect(extractAquaPoolData(concentratedPoolFixture.xdr, tokenMeta)).toBeNull()
    })
})

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