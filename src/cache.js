const {StrKey} = require('@stellar/stellar-sdk')
const {xdrParseResult} = require('./dex/meta-processor')
const {normalizeTimestamp} = require('./utils')

/**
 * @typedef {import('./rpc-connector')} RpcConnector
 * @typedef {import('./pools/pool-provider-base')} PoolProviderBase
 * @typedef {import('./dex/meta-processor').Trade} Trade
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
        this.__tick = this.__worker(normalizeTimestamp(Date.now(), this.period * 1000))
    }

    get network() {
        return this.rpcConnector.network
    }

    /**
     * @param {number} targetTimestamp - timestamp in ms
     */
    async __worker(targetTimestamp) {
        console.info({msg: 'Start stellar-connector pools instance worker', network: this.network, targetTimestamp})
        try {
            let dataTimestamp = 0
            while (targetTimestamp + 10000 > Date.now()) { //wait up to 10 seconds after the target timestamp
                if (this.__disposed)
                    return
                const info = await this.rpcConnector.getLedgerInfo()
                const ledgerCloseTime = (info?.latestLedgerCloseTime ?? 0) * 1000
                if (ledgerCloseTime > targetTimestamp) {
                    dataTimestamp = info.latestLedgerCloseTime
                    console.debug({msg: 'Ledger close time', network: this.network, ledgerCloseTime, targetTimestamp})
                    break //we have reached the target timestamp
                }
                await new Promise(resolve => setTimeout(resolve, 500))
            }
            if (!dataTimestamp) {
                console.warn({msg: 'Unable to receive ledger close time', targetTimestamp, network: this.network})
                return
            }
            if (this.__disposed)
                return
            //update cache with recent data
            const poolData = await this.rpcConnector.loadContractInstances([...this.poolContracts.keys()])
            if (this.__disposed)
                return
            if (!poolData || poolData.size === 0) {
                //still stage empty poolData so the current slot is marked worker-visited
                console.warn({msg: 'No pool contracts defined for stellar-connector pools instance', network: this.network})
            }
            this.pendingPoolData = {timestamp: normalizeTimestamp(dataTimestamp, this.period), poolData: poolData || new Map()}
        } catch (err) {
            console.error({err, msg: 'Error in stellar-connector pools instance', network: this.network})
        } finally {
            targetTimestamp += this.period * 1000 //period to ms
            const timeout = targetTimestamp - 100 - Date.now() //run 100 milliseconds before the next period
            console.debug({msg: 'Stellar-connector timeout', network: this.network, timeout})
            if (!this.__disposed)
                this.__workerTimeout = setTimeout(() => {
                    this.__tick = this.__worker(targetTimestamp)
                }, Math.max(1, timeout))
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
     * Largest timestamp currently present in {@link timestampData}. Maintained by {@link __ensureTimestampData}.
     * @type {number}
     * @private
     */
    __latestTimestamp = 0
    /**
     * Pools data structure: key is the pool contract ID and value are the tokens and their reserves. poolData is null if no worker tick has visited the period; otherwise a Map (possibly empty).
     * @type {Map<number, {trades: Trade[], poolData: Map<string, {tokens: string[], reserves: BigInt[]}> | null, processedTxs: Set<string>, ledgers: {min: number, max: number}}>}
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
     * The promise of the tick currently running, so {@link dispose} can wait for it
     * @type {Promise<void>|null}
     * @private
     */
    __tick = null
    /**
     * Handle of the timer that starts the next tick. Declared here so it reads `null` before the first tick
     * completes instead of being absent, which is what makes the disposal tests deterministic
     * @type {object|null}
     * @private
     */
    __workerTimeout = null
    /**
     * @type {boolean}
     * @private
     */
    __disposed = false
    /**
     * @type {Map<string, {decimals: number}>}
     */
    tokensMeta = new Map()

    /**
     * @param {Map<number, {timestamp: number, txs:[{txHash: string, trades: Trade[]}] }>} txData - ledger data
     */
    addTxData(txData) {
        //iterate over the transaction data
        for (const [ledger, data] of txData.entries()) {
            //get or create timestamp data
            const tsTransactions = this.__ensureTimestampData(data.timestamp)
            for (const tx of data.txs) {
                if (tsTransactions.processedTxs.has(tx.txHash)) //already processed
                    continue
                //mark as processed
                tsTransactions.processedTxs.add(tx.txHash)
                //append trades
                tsTransactions.trades.push(...tx.trades)
                //add ledgers info
                if (ledger < tsTransactions.ledgers.min)
                    tsTransactions.ledgers.min = ledger
                if (ledger > tsTransactions.ledgers.max)
                    tsTransactions.ledgers.max = ledger
            }
            if (this.lastCachedLedger < ledger)
                this.lastCachedLedger = ledger
        }
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
    getPoolVolumesForPeriod(from, to) {
        const result = []
        //go through all timestamps in the range and collect pool data from the latest one
        for (let ts = from; ts < to; ts += this.period) {
            //get timestamp data
            const timestampData = this.timestampData.get(ts)
            if (timestampData && timestampData.poolData) {
                const preparedPoolData = []
                for (const [key, value] of timestampData.poolData.entries()) {
                    preparedPoolData.push({...value, poolId: key})
                }
                result.push(...preparedPoolData)
            }
        }
        return result
    }

    /**
     * Whether every slot in the range has been visited by the pool worker (poolData is a Map, possibly empty).
     * @param {number} from - period range start
     * @param {number} to - period range end
     * @return {boolean}
     */
    hasPoolDataForPeriod(from, to) {
        for (let ts = from; ts < to; ts += this.period) {
            const data = this.timestampData.get(ts)
            if (!data || data.poolData === null)
                return false
        }
        return true
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
                console.info({msg: 'Token decimals loaded', token, decimals: res})
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
        //process transaction data
        await this.__processTxData(period, limit)
        //update tracked contracts
        this.poolContracts = poolContracts
        //process pending pool data
        this.__processPoolData()
        //clean up unneeded entries from cache
        this.__evictExpired()
    }

    async __processTxData(period, limit) {
        //generate ledger sequence ranges to load transactions
        const ranges = await this.rpcConnector.generateLedgerRanges(this.lastCachedLedger, period, limit + 1, 3)
        //we need to create temp tx storage to have an ability to remove all data that can have integrity issues
        const tempTxData = new Map()
        //function to add transaction data to the temporary map
        const addToTemp = (tx) => {
            try {
                //normalize timestamp
                const txTimestamp = normalizeTimestamp(tx.createdAt, this.period)

                //get or create timestamp data
                const tsTransactions = this.__ensureTimestampData(txTimestamp)
                if (tsTransactions.processedTxs.has(tx.txHash)) //already processed
                    return

                //try get trades from the transaction
                const trades = xdrParseResult(tx) || []
                let ledgerData = tempTxData.get(tx.ledger)
                if (!ledgerData) {
                    ledgerData = {txs: [], hashes: new Set(), timestamp: txTimestamp}
                    tempTxData.set(tx.ledger, ledgerData)
                }
                //push tx and trade data
                ledgerData.txs.push({trades, txHash: tx.txHash})
                ledgerData.hashes.add(tx.txHash)
            } catch (err) {
                //a single unusable transaction must never fail the range it arrived in
                console.error({msg: 'Error processing transaction', txHash: tx?.txHash, ledger: tx?.ledger, err})
            }
        }
        //load ranges in parallel
        const results = await Promise.all(ranges.map(range => this.rpcConnector.fetchTransactions(range.from, range.to, tx => addToTemp(tx))
            .then(() => ({range}))
            .catch(err => ({error: err, range}))
        ))

        //find earliest error — we evict everything from the first gap onward so the next tick refetches it
        const error = results.filter(r => r.error).sort((a, b) => a.range.from - b.range.from)[0]
        if (error) {
            console.error({msg: 'Error fetching transactions', err: error.error, range: error.range})
            //remove all ledgers that are newer or equal to the failed one
            const ledgers = [...tempTxData.keys()].filter(l => l >= error.range.from)
            for (const ledger of ledgers) {
                tempTxData.delete(ledger)
            }
            if (ledgers.length > 0)
                console.warn({msg: 'Evicted ledgers after range failure', evicted: ledgers.length, fromLedger: error.range.from})
        }

        //add tx data to cache
        this.addTxData(tempTxData)
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
            //get pool last modified ledger
            const poolLedger = instanceData.lastModifiedLedgerSeq
            //decode pool instance data
            const {reserves, tokens} =
                provider.processPoolInstance(instanceData.xdr, contractId, this.network, this.tokensMeta, poolLedger) || {}
            if (!reserves || !tokens)
                continue //invalid or unsupported pool - skip
            //attach pools data to target timestamps
            const targetTimestampData = this.__getPoolAttachTargets(poolLedger, timestamp)
            for (const [, data] of targetTimestampData) {
                //lazy-init Map for slots never worker-visited
                if (data.poolData === null)
                    data.poolData = new Map()
                //set pool data
                data.poolData.set(contractId, {reserves, tokens})
            }
            if (targetTimestampData.size > 1) { //multi-slot backfill is the interesting case; the current slot is implied by the processing entry
                console.debug({msg: 'Pool data attached', poolId: contractId, ledger: poolLedger, timestamps: [...targetTimestampData.keys()]})
            }
        }
        //mark current slot as worker-visited even if no pools applied
        const currentSlot = this.__ensureTimestampData(timestamp)
        if (currentSlot.poolData === null)
            currentSlot.poolData = new Map()
        //clear pending data
        this.pendingPoolData = null
    }

    __getPoolAttachTargets(ledger, currentTimestamp) {
        //walk slots ascending — once one covers the pool's last-modified ledger, every later slot inherits the same stable state
        const timestamps = [...this.timestampData.keys()].filter(t => t < currentTimestamp).sort((a, b) => a - b)
        const targetTimestampData = new Map()
        let foundCoveringSlot = false
        for (const timestamp of timestamps) {
            const data = this.timestampData.get(timestamp)
            if (data.ledgers.max >= ledger)
                foundCoveringSlot = true
            if (foundCoveringSlot)
                targetTimestampData.set(timestamp, data)
        }
        targetTimestampData.set(currentTimestamp, this.__ensureTimestampData(currentTimestamp))
        return targetTimestampData
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
        timestamps.sort((a, b) => a - b)
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
        tsData = {trades: [], poolData: null, processedTxs: new Set(), ledgers: {min: Infinity, max: 0}}
        this.timestampData.set(timestamp, tsData)
        if (timestamp > this.__latestTimestamp)
            this.__latestTimestamp = timestamp
        return tsData
    }

    /**
     * Stop the worker and wait for a tick that is already running, so no request outlives the cache
     * @return {Promise<void>}
     */
    async dispose() {
        this.__disposed = true
        if (this.__workerTimeout) {
            clearTimeout(this.__workerTimeout)
            this.__workerTimeout = null
        }
        await this.__tick
    }
}

module.exports = TxCache