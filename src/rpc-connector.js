const {rpc} = require('@stellar/stellar-sdk')

class RpcConnector {
    /**
     * Create Core DB connector instance
     * @param {string} rpcUrl
     * @param {TradesCache} cache
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
     * @type {RpcServer}
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
            for (let tx of res.transactions) {
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
                console.warn('Failed getTransactions request', params)
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
            let to = from + rangeSize - 1
            ranges[i] = {from, to}
        }
        //set upper boundary for the last range to overcome possible rounding issues
        ranges[rangeLimit - 1].to = sequence
        return ranges
    }
}

module.exports = RpcConnector