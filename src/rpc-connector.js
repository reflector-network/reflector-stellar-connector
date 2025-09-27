const {xdr, Address} = require('@stellar/stellar-sdk')
const {invokeRpcMethod} = require('./utils')

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
     * Create RPC connector instance
     * @param {string[]} rpcUrls - URLs of the RPC servers with enabled `getTransactions` and `getLedgerEntries` endpoints
     */
    constructor(rpcUrls) {
        this.rpcUrls = rpcUrls
    }

    /**
     * @type {string[]}
     * @readonly
     */
    rpcUrls

    /**
     * @param {number} from - Range lower bound ledger (inclusive)
     * @param {number} to - Range upper bound ledger (inclusive)
     * @param {function} onSuccessTxCb - Callback to process each successful transaction
     */
    async fetchTransactions(from, to, onSuccessTxCb) {
        const processTransactions = async (params) => {
            const res = await invokeRpcMethod(this.rpcUrls, 'getTransactions', params)
            const transactions = res.transactions || []
            if (transactions.length === 0)
                return //no transactions to process - stop processing
            for (const tx of transactions) {
                if (tx.ledger > to) { //reached the upper boundary - stop processing transactions here
                    return
                }
                if (tx.status === 'SUCCESS') { //ignore failed transactions
                    onSuccessTxCb(tx)
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
     * @param {number} lastCachedLedger - Last cached ledger sequence
     * @param {number} period - Period in seconds
     * @param {number} total - Number of periods to fetch
     * @param {number} rangeLimit - Number of ranges to return
     * @return {Promise<{from: number, to: number}[]>}
     */
    async generateLedgerRanges(lastCachedLedger, period, total, rangeLimit) {
        const {secondsPerLedger, latestLedger} = await this.getLedgerInfo()
        //guess first ledger to load
        let firstLedgerToLoad = latestLedger - Math.ceil(period / secondsPerLedger) * total
        if (lastCachedLedger > firstLedgerToLoad) {
            firstLedgerToLoad = lastCachedLedger + 1
        }
        //determine range size
        const rangeSize = Math.ceil((latestLedger - firstLedgerToLoad) / rangeLimit)
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
        ranges[rangeLimit - 1].to = latestLedger - 1
        return ranges
    }

    async getLedgerInfo() {
        //retrieve latest available ledger sequence
        const {latestLedgerCloseTime, latestLedger, oldestLedgerCloseTime, oldestLedger} = await this.getTransaction('0'.repeat(64))

        //compute seconds per ledger
        const secondsPerLedger = (latestLedgerCloseTime - oldestLedgerCloseTime) / (latestLedger - oldestLedger)
        return {secondsPerLedger, latestLedger}
    }

    /**
     * Load ledger entries from RPC
     * @param {string[]} contracts - Array of contract IDs to load
     * @return {Promise<Map<string, {key: string, xdr: string, lastModifiedLedger: number, liveUntilLedgerSeq: number}>>} Map of contract IDs to their ledger entries
     */
    async loadContractInstances(contracts) {
        //create contract props mapping
        const generateKeys = () => {
            const maxEntries = 200 //max entries per request

            let currentChunk = new Map() //current chunk of keys
            const chunks = [currentChunk]
            for (const contract of contracts) {
                if (currentChunk.size >= maxEntries) { //max entries per request
                    currentChunk = new Map()
                    chunks.push(currentChunk)
                }
                currentChunk.set(generateInstanceLedgerKey(contract).toXDR('base64'), contract)
            }
            return chunks
        }
        const keyChunks = generateKeys()
        for (let i = 0; i < 3; i++) { //max 3 attempts
            try {
                const instances = new Map()
                for (const chunk of keyChunks) {
                    const chunkData = await invokeRpcMethod(this.rpcUrls, 'getLedgerEntries', {keys: [...chunk.keys()]})
                    if (chunkData?.entries) {
                        chunkData.entries.forEach(entry => {
                            //map entry to contract ID
                            const contractId = chunk.get(entry.key)
                            instances.set(contractId, entry)
                        })
                    }
                }
                return instances
            } catch (e) {
                console.warn({err: e, msg: 'Failed getTransactions request'})
            }
        }
        throw new Error('Failed to load contracts data from RPC')
    }

    async getTransaction(hash) {
        if (!hash)
            throw new Error('Transaction hash is required')
        return await invokeRpcMethod(this.rpcUrls, 'getTransaction', {hash})
    }
}

module.exports = RpcConnector