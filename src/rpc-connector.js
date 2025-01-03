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

    async getTransactions(params) {
        for (let i = 0; i < 3; i++) { //max 3 attempts
            try {
                return await this.server.getTransactions(params)
            } catch (e) {
                console.warn('Failed getTransactions request', params)
                params.pagination.limit -= 10 //try to decrease the number of transactions to fetch
            }
        }
        throw new Error('Failed to load transactions from RPC')
    }

    /**
     * @param {number} period - Period in seconds
     * @param {number} limit - Number of periods to fetch
     * @return {Promise<{from: number, to: number}[]>}
     */
    async getBatchInfos(period, limit) {
        const {sequence} = await this.server.getLatestLedger()
        const ledgersInPeriod = Math.floor(period / 5) //5 lps
        const batches = []
        const lastCachedLedger = this.cache.lastCachedLedger
        let outOfRange = false
        const getFromLedger = (ledger, batchIndex) => {
            const from = ledger - ledgersInPeriod * batchIndex
            if (from < lastCachedLedger) {
                outOfRange = true
                return lastCachedLedger + 1 //skip already cached ledgers
            }
            return from
        }
        let to = sequence
        for (let i = 1; i <= limit; i++) {
            const from = getFromLedger(sequence, i)
            batches.push({from, to})
            to = from - 1
            if (outOfRange)
                break
        }
        batches.reverse() //fix order
        return batches
    }
}

module.exports = RpcConnector