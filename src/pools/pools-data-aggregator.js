const AggregatorBase = require('../aggregator-base')
const {getVWAP} = require('../utils')
const {applyPoolGuards} = require('./pool-guards')

class PoolsDataAggregator extends AggregatorBase {
    /**
     * @param {string} baseAsset - base asset to aggregate data against
     * @param {string[]} assets - list of assets to aggregate data for
     * @param {string} network - network passphrase
     * @param {number} ts - timestamp for the aggregation
     * @param {{minBaseVolume: number}} guards - resolved pool guards
     */
    constructor(baseAsset, assets, network, ts, guards) {
        super(baseAsset, assets, network, ts)
        if (!guards)
            throw new Error('Pool guards are required')
        this.ts = ts
        this.guards = guards
    }

    /**
     * Aggregates volumes for all tokens data
     * @param {{reserves: BigInt[], tokens: string[], poolId: string}[]} poolTokenData - tokens data
     */
    processTokenReserves(poolTokenData) {
        const candidatesByAsset = new Map()
        for (const {reserves, tokens, poolId} of poolTokenData) {
            const baseTokenIndex = tokens.indexOf(this.baseToken)
            if (baseTokenIndex < 0)
                continue //base token not found in the pool
            const asset = this.tokens.get(tokens[1 - baseTokenIndex])
            if (!asset)
                continue //asset not tracked
            const baseVolume = reserves[baseTokenIndex]
            const quoteVolume = reserves[1 - baseTokenIndex]
            if (typeof baseVolume !== 'bigint' || typeof quoteVolume !== 'bigint')
                continue //unusable reserves
            let candidates = candidatesByAsset.get(asset)
            if (!candidates) {
                candidates = []
                candidatesByAsset.set(asset, candidates)
            }
            candidates.push({poolId, baseVolume, quoteVolume, price: getVWAP(baseVolume, quoteVolume)})
        }
        for (const [asset, candidates] of candidatesByAsset) {
            const {accepted, rejected} = applyPoolGuards(candidates, this.guards)
            for (const pool of accepted) {
                this.addVolumes(asset, pool.baseVolume, pool.quoteVolume, {baseToken: this.baseToken, poolId: pool.poolId})
            }
            //what this node priced with and what it refused, for every period
            //one compact field per pool - `poolId:baseVolume/quoteVolume@price` - because an object per pool overruns max-len
            const acceptedLog = accepted.map(p => `${p.poolId}:${p.baseVolume}/${p.quoteVolume}@${p.price}`).join(' ')
            //a floor rejection fires for every dust pool on every asset every period and the Aqua list is full of
            //them, so it must not raise the level or the 2 MB x 20 retention window this exists to protect is gone.
            //The floor is the only routine reason left - a malformed candidate is a broken feed and worth the line -
            //so this is written as "anything but the floor" rather than naming the malformed reason, and any reason
            //added later is reported rather than silently inheriting the dust exemption
            const notable = rejected.some(r => r.reason !== 'below the liquidity floor')
            const logLevel = notable ? console.info : console.debug
            logLevel({
                msg: 'Pool volumes applied',
                baseAsset: this.baseAsset,
                asset,
                ts: this.ts,
                accepted: acceptedLog,
                rejected
            })
        }
    }
}

module.exports = PoolsDataAggregator
