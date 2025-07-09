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
        const processTransactions = async (params) => {
            const res = await this.getTransactions(params)
            const transactions = res.transactions || []
            if (transactions.length === 0)
                return //no transactions to process - stop processing
            for (const tx of transactions) {
                if (tx.ledger > to) { //reached the upper boundary - stop processing transactions here
                    return
                }
                if (tx.status === 'SUCCESS') { //ignore failed transactions
                    this.cache.addTx(tx)
                }
            }
            return res.cursor //continue processing transactions
        }

        const limit = 200
        let cursor = undefined
        do {
            const params = cursor ?
                {pagination: {limit, cursor}} :
                {startLedger: from, pagination: {limit}}
            //if we reached the upper boundary or no more transactions returned
            cursor = await processTransactions(params)
        } while (cursor)
    }

    /**
     * @param {{}} params - Parameters for the getTransactions request
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
        const expectedSecondsPerLedger = await this.getSecondsPerLedger()
        //retrieve latest available ledger sequence
        const {sequence} = await this.server.getLatestLedger()
        //retrieve last known processed ledger sequence
        const {lastCachedLedger} = this.cache
        //guess first ledger to load
        let firstLedgerToLoad = sequence - Math.ceil(period / expectedSecondsPerLedger) * total
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

    async getSecondsPerLedger() {
        //retrieve latest available ledger sequence
        const {sequence} = await this.server.getLatestLedger()
        //TODO: use sdk method when it will be available
        //retrieve info about ledgers
        const options = {
            jsonrpc: '2.0',
            id: Date.now(),
            method: "getLedgers",
            params:
            {
                startLedger: sequence,
                pagination: {limit: 1}
            }
        }
        const response = await fetch(this.server.serverURL.toString(), {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(options)
        }).then(res => res.json())

        if (!response?.result)
            throw new Error('Failed to load ledgers from RPC')

        const {latestLedgerCloseTime, latestLedger, oldestLedgerCloseTime, oldestLedger} = response.result

        //compute seconds per ledger
        const secondsPerLedger = (latestLedgerCloseTime - oldestLedgerCloseTime) / (latestLedger - oldestLedger)
        return secondsPerLedger
    }

    /**
     * Load ledger entries from RPC
     * @param {string[]} contracts - Array of contract IDs to load
     * @return {Promise<ContractDataEntry[]>}
     */
    async loadContractsData(contracts) {
        //create contract props mapping
        const generateKeys = () => {
            const maxEntries = 200 //max entries per request

            let currentChunk = [] //current chunk of keys
            const chunks = [currentChunk]
            for (const contract of contracts) {
                if (currentChunk.length >= maxEntries) { //max entries per request
                    currentChunk = []
                    chunks.push(currentChunk)
                }
                currentChunk.push(generateInstanceLedgerKey(contract))
            }
            return chunks
        }
        const keyChunks = generateKeys()
        for (let i = 0; i < 3; i++) { //max 3 attempts
            try {
                const data = []
                for (const chunk of keyChunks) {
                    const chunkData = await this.server.getLedgerEntries(...chunk)
                    if (chunkData?.entries) {
                        data.push(...chunkData.entries)
                    }
                }
                return data
            } catch (e) {
                console.warn({err: e, msg: 'Failed getTransactions request'})
            }
        }
        throw new Error('Failed to load contracts data from RPC')
    }
}

module.exports = RpcConnector