const AggregatorBase = require('../aggregator-base')

class PoolsDataAggregator extends AggregatorBase {

    /**
     * Aggregates volumes for all tokens data
     * @param {{reserves: BigInt[], token: string}[]} poolTokenData - tokens data
     */
    processTokenReserves(poolTokenData) {
        for (const {reserves, asset} of poolTokenData) {
            this.addVolumes(asset, reserves[0], reserves[1])
        }
    }
}

module.exports = PoolsDataAggregator