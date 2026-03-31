/*eslint-disable class-methods-use-this */
class PoolProviderBase {
    constructor() {
        if (this.constructor === PoolProviderBase)
            throw new Error("Cannot instantiate abstract class PoolProviderBase")
    }

    /**
     * Get pool type
     * @type {string}
     */
    get type() {
        throw new Error("Abstract method type must be implemented in derived class")
    }

    /**
     * Returns a map of pools for the given base asset and assets.
     * @param {string} baseAsset - oracle base token
     * @param {string[]} assets - oracle base token
     * @param {string} network - network passphrase
     * @return {string[]}
     */
    async getTargetPools(baseAsset, assets, network) {
        throw new Error("Abstract method getTargetPools must be implemented in derived class")
    }

    /**
     * @param {string} poolInstance - pool data instances
     * @param {string} contractId - pool contract id
     * @param {string} network - network passphrase
     * @param {Map<string, {decimals: number}>} tokenMeta - Metadata for tokens to aggregate pools data for
     * @return {{reserves: BigInt[], tokens: string[]}|null} - pool reserves and tokens or null if the pool is invalid.
     */
    processPoolInstance(poolInstance, contractId, network, tokenMeta) {
        throw new Error("Abstract method processPoolInstance must be implemented in derived class")
    }
}

module.exports = PoolProviderBase