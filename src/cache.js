const {StrKey} = require('@stellar/stellar-sdk')
const {xdrParseResult} = require('./dex/meta-processor')
const {normalizeTimestamp} = require('./utils')

/**
 * @typedef {import('./rpc-connector')} RpcConnector
 * @typedef {import('./pools/pool-provider-base')} PoolProviderBase
 */

/**
 * Cache containing recent transactions, grouped by timestamp (rounded to period)
 */
class TxCache {
    /**
     * @param {RpcConnector} rpcConnector - RPC connector instance
     * @param {number} period - Period in seconds for grouping transactions
     * @param {number} cacheSize - Number of periods to keep in cache
     */
    constructor(rpcConnector, period = 60, cacheSize = 16) {
        this.size = cacheSize
        this.period = period
        this.rpcConnector = rpcConnector
        this.worker(normalizeTimestamp(Date.now(), this.period * 1000))
    }

    get network() {
        return this.rpcConnector.network
    }

    async worker(targetTimestamp) {
        console.info({msg: 'Start stellar-connector pools instance worker', network: this.network, targetTimestamp})
        try {
            let dataTimestamp = 0
            while (targetTimestamp + 10000 > Date.now()) { //wait up to 10 seconds after the target timestamp
                const info = await this.rpcConnector.getLedgerInfo()
                const ledgerCloseTime = (info?.latestLedgerCloseTime ?? 0) * 1000
                if (ledgerCloseTime > targetTimestamp) {
                    dataTimestamp = info.latestLedgerCloseTime
                    console.debug({msg: 'Ledger close time', network: this.network, ledgerCloseTime, targetTimestamp})
                    break //we have reached the target timestamp
                }
                await new Promise(resolve => setTimeout(resolve, 50))
            }
            if (!dataTimestamp) {
                console.warn({msg: 'Unable to receive ledger close time', targetTimestamp, network: this.network})
                return
            }
            //update cache with recent data
            const poolData = await this.rpcConnector.loadContractInstances([...this.poolContracts.keys()])
            if (!poolData || poolData.size === 0) {
                console.warn({msg: 'No pool contracts defined for stellar-connector pools instance', network: this.network})
                return
            }
            this.pendingPoolData = {timestamp: normalizeTimestamp(dataTimestamp, this.period), poolData}
        } catch (err) {
            console.error({err, msg: 'Error in stellar-connector pools instance', network: this.network})
        } finally {
            targetTimestamp += this.period * 1000
            const timeout = targetTimestamp - 1000 - Date.now()//run 1 second before the next period
            console.debug({msg: 'Stellar-connector timeout', network: this.network, timeout})
            this.__workerTimeout = setTimeout(() => this.worker(targetTimestamp), timeout)
        }
    }

    /**
     * @type {number}
     * @readonly
     */
    size
    /**
     * @type {number}
     * @readonly
     */
    period
    /**
     * @type {number}
     * @readonly
     */
    lastCachedLedger = 0
    /**
     * Pools data structure: key is the pool contract ID and value are the tokens and their reserves
     * @type {Map<number, {trades: Trade[], poolData: Map<string, {tokens: string[], reserves: BigInt[]}>, processedTxs: Set<string>, ledgers: {min: number, max: number}}>}
     * @private
     */
    timestampData = new Map()
    /**
     * @type {Map<string, PoolProviderBase>}
     * @private
     */
    poolContracts = new Map()
    /**
     * @type {{timestamp: number, poolData: Map<string, {key: string, xdr: string, lastModifiedLedger: number}>}}
     */
    pendingPoolData = null
    /**
     * @type {Map<string, {decimals: number}>}
     */
    tokensMeta = new Map()

    /**
     * @param {TransactionInfo} tx - transaction info object
     */
    addTx(tx) {
        //normalize timestamp
        const txTimestamp = normalizeTimestamp(tx.createdAt, this.period)

        //get or create timestamp data
        const tsTransactions = this.__ensureTimestampData(txTimestamp)
        if (tsTransactions.processedTxs.has(tx.txHash)) //already processed
            return

        //try get trades from the transaction
        const trades = xdrParseResult(tx)

        this.addTxToPeriod(tx.txHash, trades, txTimestamp, tx.ledger)

        if (tx.ledger > this.lastCachedLedger)
            this.lastCachedLedger = tx.ledger
    }

    /**
     * @param {string} txHash
     * @param {{amountBought: bigint, amountSold: bigint, assetBought: string, assetSold: string}[]} trades
     * @param {number} timestamp
     * @param {number} ledger
     * @private
     */
    addTxToPeriod(txHash, trades, timestamp, ledger) {
        const tsTransactions = this.__ensureTimestampData(timestamp)

        //mark as processed
        tsTransactions.processedTxs.add(txHash)
        //append trades
        tsTransactions.trades.push(...trades)
        //add ledgers info
        if (ledger < tsTransactions.ledgers.min)
            tsTransactions.ledgers.min = ledger
        if (ledger > tsTransactions.ledgers.max)
            tsTransactions.ledgers.max = ledger
    }

    /**
     * @param {number} from
     * @param {number} to
     * @return {Trade[]}
     */
    getTradesForPeriod(from, to) {
        const trades = []
        for (let ts = from; ts < to; ts += this.period) {
            const periodData = this.timestampData.get(ts)
            if (periodData)
                trades.push(...periodData.trades)
        }
        return trades
    }

    /**
     * @param {number} from
     * @param {number} to
     * @return {{tokens: string[], reserves: BigInt[]}[]}
     */
    getPoolsDataForPeriod(from, to) {
        const result = []
        //go through all timestamps in the range and collect pool data from the latest one
        for (let ts = from; ts < to; ts += this.period) {
            //get timestamp data
            const timestampData = this.timestampData.get(ts)
            if (timestampData)
                result.push(...[...timestampData.poolData.values()])
        }
        return result
    }


    /**
     * Update tokens metadata in cache by loading it from the blockchain
     * @param {string[]} assets - List of asset contract IDs to update metadata for
     * @param {string} accountId - Account ID to use for simulating transactions (default is the system account from Reflector pubnet cluster)
     * @return {Promise<void>}
     */
    async updateTokenMeta(assets, accountId = "GDLMOS3LF2CRRFCWDJ6TX3YIEYBBTZGAF3BSSEXOXFZWYHSCOHT6DRFX") {
        if (!accountId)
            return
        const now = Date.now()
        //find all tokens that are not loaded yet, or that need to be retried due to previous failed attempt (with 1 hour cooldown)
        const tokensToLoad = assets
            .filter(a => StrKey.isValidContract(a))
            .filter(a => !this.tokensMeta.has(a)
                || now - this.tokensMeta.get(a).failedAt > 60 * 60 * 1000)
        if (tokensToLoad.length === 0)
            return
        const requests = []
        for (const token of tokensToLoad) {
            const request = this.rpcConnector.simulateTransaction(accountId, {
                function: 'decimals',
                contract: token,
                args: []
            }).then(result => {
                const res = Number(result[0])
                if (isNaN(res) || res < 0 || res > 255)
                    throw new Error(`Invalid decimals value for token ${token}: ${result[0]}`)
                this.tokensMeta.set(token, {decimals: res})
            }).catch(err => {
                console.error({msg: 'Error loading token decimals', token, err})
                this.tokensMeta.set(token, {failedAt: now}) //set empty meta to avoid repeated failed attempts
            })
            requests.push(request)
        }
        await Promise.all(requests)
    }

    /**
     * @param {number} period - Period in seconds
     * @param {number} limit - Number of periods to fetch
     * @param {Map<string, PoolProviderBase>} poolContracts - List of pool contracts to fetch with their providers
     * @return {Promise<void>}
     */
    async updateCache(period, limit, poolContracts) {
        //generate ledger sequence ranges to load transactions
        const ranges = await this.rpcConnector.generateLedgerRanges(this.lastCachedLedger, period, limit + 1, 3)
        //load ranges in parallel
        await Promise.all(ranges.map(range => this.rpcConnector.fetchTransactions(range.from, range.to, tx => this.addTx(tx))))
        //update tracked contracts
        this.poolContracts = poolContracts
        //process pending pool data
        this.__processPoolData()
        //clean up unneeded entries from cache
        this.__evictExpired()
    }

    /**
     * Process pending pool data
     * @private
     */
    __processPoolData() {
        //retrieve pending pool data
        if (!this.pendingPoolData)
            return
        const {timestamp, poolData} = this.pendingPoolData
        //iterate over all loaded pool instances
        for (const [contractId, instanceData] of poolData) {
            const provider = this.poolContracts.get(contractId)
            if (!provider)
                continue //unknown contract - skip
            //decode pool instance data
            const {reserves, tokens} = provider.processPoolInstance(instanceData.xdr, contractId, this.network, this.tokensMeta) || {}
            if (!reserves || !tokens)
                continue //invalid or unsupported pool - skip
            //get pool last modified ledger
            const poolLedger = instanceData.lastModifiedLedgerSeq
            let timestampData = null
            //try find existing timestamp entry that contains pool data for the same or earlier ledger
            if (this.timestampData.size) {
                const lastTsData = [...this.timestampData][this.timestampData.size - 1][1]
                if (lastTsData.ledgers.max >= poolLedger) //set last available pool data only if the pool was updated before the last timestamp
                    timestampData = lastTsData
            }
            //if not found, create a new entry for the pools data timestamp
            if (!timestampData) {
                timestampData = this.__ensureTimestampData(timestamp)
            }
            //set pool data
            timestampData.poolData.set(contractId, {reserves, tokens})
        }
        //clear pending data
        this.pendingPoolData = null
    }

    /**
     * Remove expired periods from cache
     * @private
     */
    __evictExpired() {
        const removeCount = this.timestampData.size - this.size
        if (removeCount <= 0)
            return
        const timestamps = Array.from(this.timestampData.keys())
        timestamps.sort()
        const keysToRemove = timestamps.slice(0, removeCount)
        for (const key of keysToRemove) {
            this.timestampData.delete(key)
        }
    }

    /**
     * Ensure that timestamp data entry exists
     * @param {number} timestamp
     * @return {{trades: Trade[], poolData: Map<string, Map<string, BigInt[]>>, processedTxs: Set<string>, ledgers: {min: number, max: number}}}
     * @private
     */
    __ensureTimestampData(timestamp) {
        let tsData = this.timestampData.get(timestamp)
        if (tsData)
            return tsData
        tsData = {trades: [], poolData: new Map(), processedTxs: new Set(), ledgers: {min: Infinity, max: 0}}
        this.timestampData.set(timestamp, tsData)
        return tsData
    }
}

module.exports = TxCache