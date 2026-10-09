/*eslint-disable no-undef */
const {defaultPoolGuards, resolvePoolGuards, applyPoolGuards} = require('../src/pools/pool-guards')

console.debug = jest.fn()
console.info = jest.fn()
console.warn = jest.fn()
console.error = jest.fn()
console.log = jest.fn()

const unit = 10n ** 14n

/**
 * @param {string} poolId - pool id
 * @param {number} base - base-side reserve in whole units
 * @param {number} quote - quote-side reserve in whole units
 * @returns {{poolId: string, baseVolume: BigInt, quoteVolume: BigInt, price: BigInt}}
 */
function candidate(poolId, base, quote) {
    const baseVolume = BigInt(base) * unit
    const quoteVolume = BigInt(quote) * unit
    return {poolId, baseVolume, quoteVolume, price: baseVolume * unit / quoteVolume}
}

/**
 * A pool holding `base` whole base units at a price of `hundredths / 100`, for prices no whole reserve pair hits
 * @param {string} poolId - pool id
 * @param {number} base - base-side reserve in whole units
 * @param {number} hundredths - price in hundredths of a base unit per quote unit
 * @returns {{poolId: string, baseVolume: BigInt, quoteVolume: BigInt, price: BigInt}}
 */
function poolAt(poolId, base, hundredths) {
    const baseVolume = BigInt(base) * unit
    const quoteVolume = baseVolume * 100n / BigInt(hundredths)
    return {poolId, baseVolume, quoteVolume, price: baseVolume * unit / quoteVolume}
}

describe('resolvePoolGuards', () => {
    beforeEach(() => jest.clearAllMocks())

    test('returns the documented default', () => {
        expect(resolvePoolGuards()).toEqual({minBaseVolume: 100})
        expect(resolvePoolGuards()).toEqual(defaultPoolGuards)
    })

    test('accepts an integer floor and rejects anything else', () => {
        expect(resolvePoolGuards({minBaseVolume: 250})).toEqual({minBaseVolume: 250})
        expect(() => resolvePoolGuards({minBaseVolume: 0})).toThrow('Invalid pool guard value for minBaseVolume')
        expect(() => resolvePoolGuards({minBaseVolume: -1})).toThrow('Invalid pool guard value for minBaseVolume')
        expect(() => resolvePoolGuards({minBaseVolume: 1.5})).toThrow('Invalid pool guard value for minBaseVolume')
    })

    test('ignores a stale operator config instead of refusing to start', () => {
        //unknown settings change nothing nodes could disagree about: they are warned about once and dropped
        expect(resolvePoolGuards({minBaseVolume: 250, unknownGuard: 100, otherUnknownGuard: 500})).toEqual({minBaseVolume: 250})
        const warned = console.warn.mock.calls.map(c => c[0]).filter(a => a && a.msg === 'Unknown pool guard settings ignored')
        expect(warned).toEqual([{msg: 'Unknown pool guard settings ignored', settings: 'unknownGuard, otherUnknownGuard'}])
    })
})

describe('applyPoolGuards', () => {
    const guards = resolvePoolGuards()

    test('rejects a pool below the liquidity floor', () => {
        //the yETH pool from collected-logs.json: nine units a side
        const tiny = {poolId: 'tiny', baseVolume: 9n * unit, quoteVolume: 45n * unit / 10000n, price: 2000n * unit}
        const deep = candidate('deep', 5000, 10000)
        const {accepted, rejected} = applyPoolGuards([tiny, deep], guards)
        expect(accepted.map(p => p.poolId)).toEqual(['deep'])
        expect(rejected).toEqual([{poolId: 'tiny', reason: 'below the liquidity floor'}])
    })

    test('the floor is strict: a pool holding exactly minBaseVolume counts, one raw unit less does not', () => {
        //the single bit this guard decides, and the only guard left deciding anything. The comparison is `<`, so a
        //pool holding exactly the floor is on the counting side of it and a pool one raw unit short is not. Both
        //sides are pinned because flipping `<` to `<=` moves one pool between the two sets without failing
        //anything else in this suite, and two nodes disagreeing about one pool is a divergent aggregate
        const exactly = candidate('exactly', 100, 50) //100 whole base units: the floor itself
        const short = {poolId: 'short', baseVolume: 100n * unit - 1n, quoteVolume: 50n * unit, price: 0n}
        short.price = short.baseVolume * unit / short.quoteVolume
        const {accepted, rejected} = applyPoolGuards([exactly, short], guards)
        expect(accepted.map(p => p.poolId)).toEqual(['exactly'])
        expect(rejected).toEqual([{poolId: 'short', reason: 'below the liquidity floor'}])
        //and the boundary tracks the setting rather than the constant: raise the floor past it and the same pool drops
        expect(applyPoolGuards([exactly], resolvePoolGuards({minBaseVolume: 101})).accepted).toEqual([])
    })

    test('the floor measures the base side and never the quote side', () => {
        //which side the floor reads is the whole of what it means, and a guard reading the quote side instead
        //would still look like a floor while accepting and rejecting exactly the opposite pair. Both directions
        //are pinned here: base-deep/quote-thin counts, base-thin/quote-deep does not
        const baseDeep = candidate('baseDeep', 5000, 1) //almost all of the pair's units on the base side
        const baseThin = candidate('baseThin', 1, 5000) //almost all of them on the quote side
        const {accepted, rejected} = applyPoolGuards([baseDeep, baseThin], guards)
        expect(accepted.map(p => p.poolId)).toEqual(['baseDeep'])
        expect(rejected).toEqual([{poolId: 'baseThin', reason: 'below the liquidity floor'}])
    })

    test('names a malformed candidate as malformed, not as dust', () => {
        //a non-positive price or quote reserve is a broken feed, not dust: it has a rejection reason of its own, so
        //the caller's log-level rule does not keep it at debug as it does the floor's
        const deep = candidate('deep', 5000, 10000)
        const noQuote = {poolId: 'noquote', baseVolume: 1000n * unit, quoteVolume: 0n, price: 0n}
        const negative = {poolId: 'negative', baseVolume: -5n * unit, quoteVolume: 5n * unit, price: -1n * unit}
        const {accepted, rejected} = applyPoolGuards([deep, noQuote, negative], guards)
        expect(accepted.map(p => p.poolId)).toEqual(['deep'])
        expect(rejected).toEqual([
            {poolId: 'noquote', reason: 'malformed pool reserves'},
            {poolId: 'negative', reason: 'malformed pool reserves'}
        ])
    })

    test('the floor is the only filter: every pool above it contributes its reserves untouched', () => {
        //the whole of what this function does now. Three pools 4x apart in price, one of them the majority of
        //the depth, and one below the floor: the three are accepted unmodified and in full - no quorum, no band
        //around any reference, no share cap - and the caller sums them into one volume-weighted pair
        const deepLow = candidate('deepLow', 5000, 10000) //0.5
        const deepHigh = candidate('deepHigh', 1000, 500) //2.0
        const mid = candidate('mid', 300, 300) //1.0
        const dust = poolAt('dust', 99, 200) //2.0, one unit of depth under the floor
        const {accepted, rejected} = applyPoolGuards([deepLow, deepHigh, mid, dust], guards)
        expect(accepted).toEqual([deepLow, deepHigh, mid]) //identical objects: nothing is trimmed or rescaled
        expect(rejected).toEqual([{poolId: 'dust', reason: 'below the liquidity floor'}])
        const sum = pools => pools.reduce((acc, p) => acc + p.baseVolume, 0n)
        expect(sum(accepted)).toBe(6300n * unit)
        expect(accepted.reduce((acc, p) => acc + p.quoteVolume, 0n)).toBe(10800n * unit)
        //and the result does not depend on the order the pools were discovered in
        const reversed = applyPoolGuards([dust, mid, deepHigh, deepLow], guards)
        expect(sum(reversed.accepted)).toBe(sum(accepted))
        expect(new Set(reversed.accepted.map(p => p.poolId))).toEqual(new Set(accepted.map(p => p.poolId)))
    })

    test('a pool drained across the floor takes the depth it still holds out of the sum too', () => {
        //the floor gates the count: a 120-unit pool reduced to 99 units leaves the sum entirely, the 99 units it
        //still holds included, not only the 21 taken
        const intact = []
        for (let i = 0; i < 8; i++) {
            intact.push(poolAt('intact' + i, 120, 50)) //0.5, above the floor
        }
        const drained = [...intact.slice(0, 4)]
        for (let i = 0; i < 4; i++) {
            drained.push(poolAt('drained' + i, 99, 50)) //0.5 still, swapped just under the floor
        }
        expect(applyPoolGuards(intact, guards).accepted.reduce((sum, p) => sum + p.baseVolume, 0n)).toBe(960n * unit)
        const {accepted, rejected} = applyPoolGuards(drained, guards)
        expect(accepted.map(p => p.poolId)).toEqual(['intact0', 'intact1', 'intact2', 'intact3'])
        expect(accepted.reduce((sum, p) => sum + p.baseVolume, 0n)).toBe(480n * unit) //not 876: the 99s leave whole
        for (let i = 0; i < 4; i++) {
            expect(rejected).toContainEqual({poolId: 'drained' + i, reason: 'below the liquidity floor'})
        }
    })

    test('dust that cannot contribute cannot outweigh the pool that can', () => {
        //the availability side of gating the count. Eleven 99-unit pools at 2.0 outnumber a single 1 000-unit
        //pool at 0.5 and, while sub-floor depth counted, dragged the published price with them. Below the floor
        //a pool contributes nothing, so the real pool prices the minute whatever the dust does
        const honest = candidate('honest', 1000, 2000) //0.5
        const dust = []
        for (let i = 0; i < 11; i++) {
            dust.push(poolAt('dust' + i, 99, 200)) //2.0, below the floor
        }
        const {accepted, rejected} = applyPoolGuards([honest, ...dust], guards)
        expect(accepted.map(p => p.poolId)).toEqual(['honest'])
        expect(rejected.every(r => r.reason === 'below the liquidity floor')).toBe(true)
        expect(rejected).toHaveLength(11)
        //and the thin-asset shape a quorum over the same set would void: one real pool beside scattered dust
        const real = candidate('real', 300, 300) //1.0
        const scattered = []
        for (let i = 0; i < 4; i++) {
            scattered.push(poolAt('scatter' + i, 99, 200)) //2.0, below the floor
        }
        const thin = applyPoolGuards([real, ...scattered], guards)
        expect(thin.accepted.map(p => p.poolId)).toEqual(['real'])
    })
})
