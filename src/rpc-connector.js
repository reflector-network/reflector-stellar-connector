const {xdr, Address, TransactionBuilder, Account, Keypair, scValToNative, Operation, StrKey} = require('@stellar/stellar-sdk')
const {invokeRpcMethod, rpcHost} = require('./utils')

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
            durability: xdr.ContractDataDurability.persistent
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
        new xdr.LedgerKeyLiquidityPool({liquidityPoolId: xdr.PoolId.fromXdr(Buffer.from(poolId, 'hex'))})
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
     * Read the current state of every pool, as of the ledger the RPC served it at
     * @param {string[]} contracts - pool contract IDs, or classic liquidity pool IDs (hex)
     * @return {Promise<{instances: Map<string, {key: string, xdr: string, lastModifiedLedgerSeq: number}>, servedLedger: number}|null>} the pools' entries (a pool with no entry is omitted) and the ledger they were read at; null when the read is the state at no single ledger
     */
    async loadPoolSnapshot(contracts) {
        const keyMapping = new Map()
        for (const contract of contracts) {
            const key = StrKey.isValidContract(contract)
                ? generateInstanceLedgerKey(contract)
                : generateLiquidityPoolKey(contract)
            keyMapping.set(key.toXdr('base64'), contract)
        }
        const {entries, servedLedgers} = await this.loadLedgerEntries([...keyMapping.keys()])
        const servedLedger = servedLedgers[0]
        //every 200 keys are a request of their own, and two requests can be served at different ledgers: a read that
        //mixes two states is the state at no ledger at all
        if (!Number.isSafeInteger(servedLedger) || servedLedger <= 0 || servedLedgers.some(ledger => ledger !== servedLedger)) {
            console.debug({msg: 'Pool read discarded', network: this.network, servedLedgers})
            return null
        }
        const instances = new Map()
        for (const entry of entries) {
            const contractId = keyMapping.get(entry.key)
            if (contractId)
                instances.set(contractId, entry)
        }
        console.debug({msg: 'Loaded pool instances', requested: keyMapping.size, loaded: instances.size, servedLedger})
        return {instances, servedLedger}
    }

    /**
     * Load arbitrary ledger entries from RPC (chunked to respect the per-request key limit)
     * @param {string[]} keys - base64 ledger keys
     * @return {Promise<{entries: {key: string, xdr: string, lastModifiedLedgerSeq: number}[], latestLedger: number, servedLedgers: number[]}>} - existing entries (missing keys are omitted), the highest ledger they were served at and the ledger of each chunk
     */
    async loadLedgerEntries(keys) {
        if (!keys || keys.length === 0)
            return {entries: [], latestLedger: 0, servedLedgers: []}
        const maxEntries = 200 //max entries per request
        const chunks = []
        for (let i = 0; i < keys.length; i += maxEntries) {
            chunks.push(keys.slice(i, i + maxEntries))
        }
        const validateResult = (result, rpcUrl) => {
            const host = rpcHost(rpcUrl)
            //a response without entries is indistinguishable from "no such pools" downstream, so it must fail here
            if (!result || !Array.isArray(result.entries))
                throw new Error(`getLedgerEntries response has no entries array (${host})`)
        }
        const chunkResults = await Promise.all(chunks.map(chunk =>
            invokeRpcMethod(this.rpcUrls, 'getLedgerEntries', {keys: chunk}, {validateResult})
        ))
        const entries = []
        //the ledger each chunk was served at, in chunk order: a caller that needs one state checks they agree
        const servedLedgers = []
        let latestLedger = 0
        for (const chunkData of chunkResults) {
            entries.push(...chunkData.entries)
            const servedLedger = Number(chunkData.latestLedger)
            servedLedgers.push(servedLedger)
            if (Number.isFinite(servedLedger) && servedLedger > latestLedger)
                latestLedger = servedLedger
        }
        return {entries, latestLedger, servedLedgers}
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
        })).toXdr('base64')]})

        if (!response || !response.entries || response.entries.length === 0) {
            throw new Error('Source account not found')
        }

        const sourceAccount = new Account(source, xdr.LedgerEntryData.fromXdr(response.entries[0].xdr, 'base64').value.seqNum.toString())

        //keep original source account for the restore transaction
        const transaction = new TransactionBuilder(sourceAccount, options)
            .addOperation(Operation.invokeContractFunction(invocationOp))
            .build()

        /**@type {rpc.Api.SimulateTransactionSuccessResponse} */
        const simulationResponse = await invokeRpcMethod(this.rpcUrls, 'simulateTransaction', {transaction: transaction.toXdr()})
        if (simulationResponse.error)
            throw new Error(simulationResponse.error)
        return simulationResponse.results.map(r => scValToNative(xdr.ScVal.fromXdr(r.xdr, 'base64')))
    }
}

module.exports = RpcConnector