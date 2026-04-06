const {xdr, Address, TransactionBuilder, Account, Keypair, scValToNative, Operation, StrKey} = require('@stellar/stellar-sdk')
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

/**
 * Generate ledger key for a liquidity pool
 * @param {string} poolId - hex string
 * @returns
 */
function generateLiquidityPoolKey(poolId) {
    return xdr.LedgerKey.liquidityPool(
        new xdr.LedgerKeyLiquidityPool({liquidityPoolId: xdr.PoolId.fromXDR(Buffer.from(poolId, 'hex'))})
    )
}


const maxLedgersPerRequest = 200

class RpcConnector {
    /**
     * Create RPC connector instance
     * @param {string[]} rpcUrls - URLs of the RPC servers with enabled `getTransactions` and `getLedgerEntries` endpoints
     * @param {string} network - Network passphrase
     */
    constructor(rpcUrls, network) {
        this.rpcUrls = rpcUrls
        this.network = network
    }

    /**
     * @type {string[]}
     * @readonly
     */
    rpcUrls

    /**
     * @type {string}
     * @readonly
     */
    network

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

        const limit = maxLedgersPerRequest
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
     * @param {number} periodCount - Number of periods to fetch
     * @param {number} rangeLimit - Max number of ranges to return
     * @return {Promise<{from: number, to: number}[]>}
     */
    async generateLedgerRanges(lastCachedLedger, period, periodCount, rangeLimit) {

        const {secondsPerLedger, latestLedger} = await this.getLedgerInfo()
        //guess first ledger to load
        let firstLedgerToLoad = latestLedger - Math.ceil(period / secondsPerLedger) * periodCount
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
        //filter out invalid ranges where from > to (can happen when totalLedgers < rangeLimit)
        return ranges.filter(r => r.from <= r.to)
    }

    async getLedgerInfo() {
        //retrieve latest available ledger sequence
        const {latestLedgerCloseTime: latestLedgerCloseTimeStr, latestLedger, oldestLedgerCloseTime: oldestLedgerCloseTimeStr, oldestLedger} = await this.getTransaction('0'.repeat(64))

        const latestLedgerCloseTime = Number(latestLedgerCloseTimeStr)
        const oldestLedgerCloseTime = Number(oldestLedgerCloseTimeStr)
        //compute seconds per ledger
        const secondsPerLedger = (latestLedgerCloseTime - oldestLedgerCloseTime) / (latestLedger - oldestLedger)
        return {secondsPerLedger, latestLedger, oldestLedger, oldestLedgerCloseTime, latestLedgerCloseTime}
    }

    /**
     * Load ledger entries from RPC
     * @param {string[]} contracts - Array of contract IDs to load
     * @return {Promise<Map<string, {key: string, xdr: string, lastModifiedLedger: number, liveUntilLedgerSeq: number}>>} Map of contract IDs to their ledger entries
     */
    async loadContractInstances(contracts) {
        if (!contracts || contracts.length === 0)
            return new Map() //nothing to load
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
                if (StrKey.isValidContract(contract))
                    currentChunk.set(generateInstanceLedgerKey(contract).toXDR('base64'), contract)
                else
                    currentChunk.set(generateLiquidityPoolKey(contract).toXDR('base64'), contract)
            }
            return chunks
        }
        const keyChunks = generateKeys()
        for (let i = 0; i < 3; i++) { //max 3 attempts
            try {
                const instances = new Map()
                const promises = []
                for (const chunk of keyChunks) {
                    const promise = invokeRpcMethod(this.rpcUrls, 'getLedgerEntries', {keys: [...chunk.keys()]})
                        .then(chunkData => {
                            if (chunkData?.entries) {
                                chunkData.entries.forEach(entry => {
                                    //map entry to contract ID
                                    const contractId = chunk.get(entry.key)
                                    instances.set(contractId, entry)
                                })
                            }
                        })
                    promises.push(promise)
                }
                await Promise.all(promises)
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

    /**
     * Simulate transaction on RPC
     * @param {string} source - Source account for the transaction
     * @param {{function: string, args: any[], contract: string}} invocationOp - Operation to invoke in the transaction
     * @return {Promise<any[]>} Simulation result from RPC
     */
    async simulateTransaction(source, invocationOp) {
        const options = {
            networkPassphrase: this.network,
            timebounds: {
                minTime: 0,
                maxTime: 0
            },
            fee: 10000
        }

        const response = await invokeRpcMethod(this.rpcUrls, 'getLedgerEntries', {keys: [xdr.LedgerKey.account(new xdr.LedgerKeyAccount({
            accountId: Keypair.fromPublicKey(source).xdrPublicKey()
        })).toXDR('base64')]})

        if (!response || !response.entries || response.entries.length === 0) {
            throw new Error('Source account not found')
        }

        const sourceAccount = new Account(source, xdr.LedgerEntryData.fromXDR(response.entries[0].xdr, 'base64').value().seqNum().toString())

        //keep original source account for the restore transaction
        const transaction = new TransactionBuilder(sourceAccount, options)
            .addOperation(Operation.invokeContractFunction(invocationOp))
            .build()

        /**@type {rpc.Api.SimulateTransactionSuccessResponse} */
        const simulationResponse = await invokeRpcMethod(this.rpcUrls, 'simulateTransaction', {transaction: transaction.toXDR()})
        if (simulationResponse.error)
            throw new Error(simulationResponse.error)
        return simulationResponse.results.map(r => scValToNative(xdr.ScVal.fromXDR(r.xdr, 'base64')))
    }
}

module.exports = RpcConnector