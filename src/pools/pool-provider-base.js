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
     * Pools pairing the base asset with each tracked asset
     * @param {string} baseAsset - oracle base token
     * @param {string[]} assets - tracked assets
     * @param {string} network - network passphrase
     * @param {object} [settings] - this provider's settings from the data source's providers block; unset properties take their defaults
     * @return {Promise<Map<string, string[]>>} pool ids per asset, with an entry for every asset (empty when it has
     * none); rejects when discovery fails, so a failure is never read as "no pools"
     */
    async getTargetPools(baseAsset, assets, network, settings) {
        throw new Error("Abstract method getTargetPools must be implemented in derived class")
    }

    /**
     * @param {string} poolInstance - pool data instances
     * @param {string} contractId - pool contract id
     * @param {string} network - network passphrase
     * @param {Map<string, {decimals: number}>} tokenMeta - Metadata for tokens to aggregate pools data for
     * @param {number} lastModifiedLedger - pool's last-modified ledger seq (for logging)
     * @param {number} periodTimestamp - period the snapshot is priced for, in seconds
     * @return {{reserves: BigInt[], tokens: string[]}|null} - pool reserves and tokens or null if the pool is invalid.
     */
    processPoolInstance(poolInstance, contractId, network, tokenMeta, lastModifiedLedger, periodTimestamp) {
        throw new Error("Abstract method processPoolInstance must be implemented in derived class")
    }
}

module.exports = PoolProviderBase