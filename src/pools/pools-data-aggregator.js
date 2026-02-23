const AggregatorBase = require('../aggregator-base')

class PoolsDataAggregator extends AggregatorBase {

    /**
     * Aggregates volumes for all tokens data
     * @param {{reserves: BigInt[], tokens: string[]}[]} poolTokenData - tokens data
     */
    processTokenReserves(poolTokenData) {
        for (const {reserves, tokens} of poolTokenData) {
            const baseTokenIndex = tokens.indexOf(this.baseToken)
            if (baseTokenIndex < 0)
                continue //base token not found in the pool
            const asset = this.tokens.get(tokens[1 - baseTokenIndex])
            if (!asset)
                continue //asset not tracked
            const normalizedReserves = baseTokenIndex === 0 ? reserves : [reserves[1], reserves[0]]
            this.addVolumes(asset, normalizedReserves[0], normalizedReserves[1])
        }
    }
}

module.exports = PoolsDataAggregator