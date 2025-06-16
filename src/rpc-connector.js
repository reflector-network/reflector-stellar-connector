const {rpc, xdr, Address} = require('@stellar/stellar-sdk')

/**
 * Derive contract instance ledger key from contract address
 * @param {String} contractId
 * @return {xdr.LedgerKey}
 * @private
 */
function generateInstanceLedgerKey(contractId) {
    return xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({
            contract: new Address(contractId).toScAddress(),
            key: xdr.ScVal.scvLedgerKeyContractInstance(),
            durability: xdr.ContractDataDurability.persistent()
        })
    )
}

class RpcConnector {
    /**
     * Create Core DB connector instance
     * @param {string} rpcUrl - URL of the RPC server with enabled `getTransactions` and `getLedgerEntries` endpoints
     * @param {TradesCache} cache - Cache instance to store transactions
     */
    constructor(rpcUrl, cache) {
        this.rpcUrl = rpcUrl
        this.cache = cache
        this.server = new rpc.Server(rpcUrl, {allowHttp: true})
    }

    /**
     * @type {string}
     * @readonly
     */
    rpcUrl
    /**
     * @type {rpc.Server}
     * @private
     */
    server

    /**
     * @param {number} from - Range lower bound ledger (inclusive)
     * @param {number} to - Range upper bound ledger (inclusive)
     */
    async fetchTransactions(from, to) {
        const limit = 200
        let cursor = undefined
        while (true) {
            const params = cursor ?
                {pagination: {limit, cursor}} :
                {startLedger: from, pagination: {limit}}
            const res = await this.getTransactions(params)
            if (!res.transactions?.length) //no transactions returned by the cursor
                break
            cursor = res.cursor
            let outOfRange = false
            for (const tx of res.transactions) {
                if (tx.ledger > to) { //reached the upper boundary - stop processing transactions here
                    outOfRange = true
                    break
                }
                if (tx.status === 'SUCCESS') { //ignore failed transactions
                    this.cache.addTx(tx)
                }
            }
            if (res.transactions.length < params.pagination.limit || outOfRange) //end loop if we reached the upper boundary
                break
        }
    }

    /**
     * @param {{}} params
     * @return {Promise<*>}
     * @private
     */
    async getTransactions(params) {
        for (let i = 0; i < 3; i++) { //max 3 attempts
            try {
                return await this.server.getTransactions(params)
            } catch (e) {
                console.warn({err: e, msg: 'Failed getTransactions request', args: params})
            }
        }
        throw new Error('Failed to load transactions from RPC')
    }

    /**
     * @param {number} period - Period in seconds
     * @param {number} total - Number of periods to fetch
     * @param {number} rangeLimit - Number of ranges to return
     * @return {Promise<{from: number, to: number}[]>}
     */
    async generateLedgerRanges(period, total, rangeLimit) {
        const expectedLedgersPerSecond = 5
        //retrieve latest available ledger sequence
        const {sequence} = await this.server.getLatestLedger()
        //retrieve last known processed ledger sequence
        const {lastCachedLedger} = this.cache
        //guess first ledger to load
        let firstLedgerToLoad = sequence - Math.ceil(period / expectedLedgersPerSecond) * total
        if (lastCachedLedger > firstLedgerToLoad) {
            firstLedgerToLoad = lastCachedLedger + 1
        }
        //determine range size
        const rangeSize = Math.ceil((sequence - firstLedgerToLoad) / rangeLimit)
        //init result array
        const ranges = new Array(rangeLimit)
        //generate ranges
        for (let i = 0; i < rangeLimit; i++) {
            const from = firstLedgerToLoad + rangeSize * i
            const to = from + rangeSize - 1
            ranges[i] = {from, to}
        }
        //set upper boundary for the last range to overcome possible rounding issues
        //if response from the server is null, the loading process will crash. To avoid this, we subtract 1 from the last range
        ranges[rangeLimit - 1].to = sequence - 1
        return ranges
    }

    /**
     * Load ledger entries from RPC
     * @param {string[]} contracts - Array of contract IDs to load
     * @return {Promise<ContractDataEntry[]>}
     * @private
     */
    async loadContractsData(contracts) {
        //create contract props mapping
        const keys = contracts.map(contract => generateInstanceLedgerKey(contract))
        for (let i = 0; i < 3; i++) { //max 3 attempts
            try {
                return await this.server.getLedgerEntries(...keys)
            } catch (e) {
                console.warn({err: e, msg: 'Failed getTransactions request'})
            }
        }
        throw new Error('Failed to load contracts data from RPC')
    }
}

module.exports = RpcConnector