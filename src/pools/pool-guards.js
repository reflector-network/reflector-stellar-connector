const {adjustPrecision} = require('../utils')

/**
 * Pool liquidity floor. Every node must run the same value or their aggregates diverge and the cluster drops the
 * sample, so this is a cluster-wide setting, not a local preference.
 * - minBaseVolume: whole units (not dollars) of base-side reserve a pool must hold before it contributes anything,
 * denominated in whatever asset the caller aggregates against - the base asset on the direct path, the cross asset
 * on the cross-asset path, where the result is restated into base units afterwards without a second floor.
 * It is the only pool guard left.
 */
const defaultPoolGuards = {
    minBaseVolume: 100
}

/**
 * Merge caller-supplied overrides over the defaults
 * @param {any} [raw] - overrides from the caller's options object
 * @returns {{minBaseVolume: number}}
 */
function resolvePoolGuards(raw) {
    const guards = {...defaultPoolGuards}
    if (!raw || typeof raw !== 'object')
        return guards
    const ignored = []
    for (const key of Object.keys(raw)) {
        if (!Object.prototype.hasOwnProperty.call(defaultPoolGuards, key)) {
            ignored.push(key)
            continue
        }
        const value = raw[key]
        if (value === undefined)
            continue
        if (!Number.isInteger(value) || value <= 0)
            throw new Error(`Invalid pool guard value for ${key}: ${value}`)
        guards[key] = value
    }
    //an unknown setting changes nothing nodes could disagree about, so ignoring it is safe. Refusing to start would
    //take an otherwise healthy node out of the cluster over it, so it is warned about once instead of rejected
    if (ignored.length > 0)
        console.warn({msg: 'Unknown pool guard settings ignored', settings: ignored.join(', ')})
    return guards
}

/**
 * Liquidity floor expressed at TARGET_DECIMALS
 * @param {{minBaseVolume: number}} guards - guards as `resolvePoolGuards` returns them. That is the caller
 * contract rather than a checked precondition: a bare object literal with no `minBaseVolume` throws here on the
 * BigInt conversion. `getPriceData` always resolves first, and re-validating in a second place would let the two
 * checks drift apart, which in consensus-critical code costs more than the unreachable path is worth
 * @returns {BigInt}
 */
function getMinBaseVolume(guards) {
    return adjustPrecision(BigInt(guards.minBaseVolume), 0)
}

/**
 * Apply the liquidity floor to one asset's pool candidates. A pool holding less than `minBaseVolume` whole units
 * of base-side reserve contributes nothing; every pool at or above it is passed through untouched and the caller
 * sums them into a volume-weighted aggregate. Being accepted here is not the same as counting: the accumulator
 * drops a pool with either side below MIN_VOLUME (1e-5 whole units), so an accepted pool with a dust quote side
 * still adds nothing - see asset-volumes-accumulator.js.
 * The floor stops a dust pool pricing an asset.
 * @param {{poolId: string, baseVolume: BigInt, quoteVolume: BigInt, price: BigInt}[]} candidates - candidates for one asset
 * @param {{minBaseVolume: number}} guards - resolved guards
 * @returns {{accepted: {poolId: string, baseVolume: BigInt, quoteVolume: BigInt, price: BigInt}[], rejected: {poolId: string, reason: string}[]}}
 */
function applyPoolGuards(candidates, guards) {
    const accepted = []
    const rejected = []
    const minBaseVolume = getMinBaseVolume(guards)
    for (const c of candidates) {
        //a non-positive price or quote reserve is a broken feed, not dust, and it gets its own reason: the
        //caller keeps the floor rejection at debug because dust fires on every asset every period, and a
        //malformed entry sharing that reason inherited the silence. It is a data-sanity check on unusable
        //input rather than a guard - without it a garbage pair enters the volume sum
        if (c.price <= 0n || c.quoteVolume <= 0n) {
            rejected.push({poolId: c.poolId, reason: 'malformed pool reserves'})
            continue
        }
        if (c.baseVolume < minBaseVolume) {
            rejected.push({poolId: c.poolId, reason: 'below the liquidity floor'})
            continue
        }
        accepted.push(c)
    }
    return {accepted, rejected}
}

module.exports = {
    defaultPoolGuards,
    resolvePoolGuards,
    getMinBaseVolume,
    applyPoolGuards
}
