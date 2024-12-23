const {rpc} = require('@stellar/stellar-sdk')

/**
 * Cache for ts > ledger lookup (singleton)
 * @type {{sequence: number, ts: number}}
 */
let lastCachedLedgerTimestamp

class RpcConnector {
    /**
     * Create Core DB connector instance
     * @param {string} rpcUrl
     */
    constructor(rpcUrl) {
        this.rpcUrl = rpcUrl
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
     * @param {number} from - Range lower bound timestamp (inclusive)
     * @param {number} to - Range upper bound timestamp (inclusive)
     * @param {function} processResultCallback - Record processing callback
     * @param {boolean} [onlySuccessfulTransactions] - Whether to process successful transactions only
     */
    async fetchTransactions(from, to, processResultCallback, onlySuccessfulTransactions = true) {
        const limit = 200
        let cursor = undefined
        const fromLedger = await this.findSequenceByDate(from)
        while (true) {
            const params = cursor ?
                {pagination: {limit, cursor}} :
                {startLedger: fromLedger, pagination: {cursor}}
            const res = await this.server.getTransactions(params)
            if (!res.transactions?.length) //no transactions returned by the cursor
                break
            cursor = res.cursor
            let outOfRange = false
            let processed = 0
            for (let tx of res.transactions) {
                if (tx.createdAt > to) { //reached the upper boundary - stop processing transactions here
                    outOfRange = true
                    break
                }
                if (tx.status === 'SUCCESS') { //ignore
                    processResultCallback(tx)
                    processed++
                }
                lastCachedLedgerTimestamp = {sequence: tx.ledger, ts: tx.createdAt}
            }
            console.log(processed)
            if (outOfRange) //end loop if we reached the upper boundary
                break
        }
        console.log('finished')
    }

    /**
     * @param {number} date - Unix date
     * @return {Promise<number>}
     * @private
     */
    async findSequenceByDate(date) {
        //TODO: this approach is terrible - need to ask SDF to provide better API
        //try to use cached value
        if (lastCachedLedgerTimestamp && Math.abs(date - lastCachedLedgerTimestamp.ts) <= 10)
            return lastCachedLedgerTimestamp.sequence + 1
        //find the ledger
        const maxAttempts = 50 //we cannot iterate endlessly, if we are off by more than 50 ledgers -- something is wrong
        const {sequence} = await this.server.getLatestLedger()
        const now = Math.floor(new Date().getTime() / 1000)
        let expected = sequence - Math.floor((now - date) / 6) //expect 6 lps
        let candidate
        for (let i = 0; i < maxAttempts; i++) {
            const txGuess = await this.server.getTransactions({startLedger: expected, pagination: {limit: 1}})
            if (!txGuess.transactions?.length) //no transactions returned by the cursor
                break
            const {ledger, createdAt} = txGuess.transactions[0]
            if (createdAt === date)   //exact match
                return ledger
            if (createdAt >= date) {  //potential match
                candidate = ledger    //use this sequence as candidate
                expected = ledger - 1 //move back
            } else {
                if (candidate)
                    return candidate  //it's the first ledger with timestamp < date -- return next ledger
                expected = ledger + 1 //move forward to find first ledger with timestamp >= date
            }
        }
        throw new Error('Failed to find the ledger sequence by date from timestamp ' + date)
    }

    getTransactionsDirectly({startLedger, limit, cursor}) {
        return this.callRpc('getTransactions', {
            startLedger,
            pagination: {
                limit,
                cursor
            }
        })
    }

    async callRpc(method, params) {
        const res = await fetch(this.rpcUrl, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 8675309,
                method,
                params
            })
        })
        const parsed = await res.json()
        return parsed.result
    }
}

module.exports = RpcConnector