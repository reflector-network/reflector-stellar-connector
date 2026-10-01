/*eslint-disable no-undef */
const TxCache = require('../src/cache')

//Mocks
const mockXdrParseResult = jest.fn(() => [{amountBought: 1n, amountSold: 2n, assetBought: 'A', assetSold: 'B'}])
jest.mock('../src/dex/meta-processor', () => ({
    xdrParseResult: (...args) => mockXdrParseResult(...args)
}))
jest.mock('../src/pool-snapshot', () => ({
    takePoolSnapshot: jest.fn()
}))
const {takePoolSnapshot} = require('../src/pool-snapshot')
//mock console
console.debug = jest.fn()
console.info = jest.fn()
console.warn = jest.fn()
console.error = jest.fn()
console.log = jest.fn()

function createMockRpcConnector() {
    return {
        getLedgerInfo: jest.fn().mockResolvedValue({latestLedgerCloseTime: Date.now(), latestLedger: 1000}),
        loadPoolSnapshot: jest.fn().mockResolvedValue(null),
        generateLedgerRanges: jest.fn().mockResolvedValue([{from: 1, to: 2}]),
        fetchTransactions: jest.fn((from, to, cb) => {
            cb({txHash: 'tx1', createdAt: 1000, ledger: 1})
            return Promise.resolve()
        }),
        simulateTransaction: jest.fn().mockResolvedValue([8]),
        network: 'testnet'
    }
}

function createMockPoolProvider() {
    return {
        processPoolInstance: jest.fn().mockReturnValue({
            reserves: [100n, 200n],
            tokens: ['A', 'B']
        })
    }
}

describe('TxCache', () => {
    const caches = []

    afterEach(() => {
        jest.clearAllMocks()
        for (const cache of caches) {
            cache.dispose()
        }
        caches.length = 0
    })

    function createCache(rpc, period, size) {
        const cache = new TxCache(rpc || createMockRpcConnector(), period, size)
        caches.push(cache)
        return cache
    }

    test('constructor initializes properties', () => {
        const rpc = createMockRpcConnector()
        const cache = createCache(rpc, 60, 10)
        expect(cache.size).toBe(10)
        expect(cache.period).toBe(60)
        expect(cache.network).toBe('testnet')
        expect(cache.rpcConnector).toBe(rpc)
        expect(cache.timestampData instanceof Map).toBe(true)
        //unknown until the first updateCache: an empty set would mean "no pools" and let DEX trades count
        expect(cache.poolContracts).toBeNull()
        expect(cache.pendingPoolData instanceof Map).toBe(true)
    })

    test('addTxData adds transactions and updates lastCachedLedger', () => {
        const cache = createCache(createMockRpcConnector(), 60, 10)
        const tsData = {
            trades: [],
            poolData: new Map(),
            processedTxs: new Set(),
            ledgers: {min: Infinity, max: 0}
        }
        cache.__ensureTimestampData = jest.fn().mockReturnValue(tsData)
        const txData = new Map([[5, {timestamp: 60, txs: [{txHash: 'tx1', trades: [{amountBought: 1n}]}]}]])
        cache.addTxData(txData)
        expect(tsData.processedTxs.has('tx1')).toBe(true)
        expect(tsData.trades).toEqual([{amountBought: 1n}])
        expect(cache.lastCachedLedger).toBe(5)
    })

    test('addTxData does not process already processed tx', () => {
        const cache = createCache(createMockRpcConnector(), 60, 10)
        const tsData = {
            trades: [],
            poolData: new Map(),
            processedTxs: new Set(['tx1']),
            ledgers: {min: Infinity, max: 0}
        }
        cache.__ensureTimestampData = jest.fn().mockReturnValue(tsData)
        const txData = new Map([[5, {timestamp: 60, txs: [{txHash: 'tx1', trades: [{amountBought: 1n}]}]}]])
        cache.addTxData(txData)
        expect(tsData.trades).toEqual([]) //tx was skipped
    })

    test('addTxData updates ledger min/max across multiple ledgers', () => {
        const cache = createCache(createMockRpcConnector(), 60, 10)
        const tsData = {
            trades: [],
            poolData: new Map(),
            processedTxs: new Set(),
            ledgers: {min: Infinity, max: 0}
        }
        cache.__ensureTimestampData = jest.fn().mockReturnValue(tsData)
        const txData = new Map([
            [5, {timestamp: 60, txs: [{txHash: 'tx1', trades: [{amountBought: 1n}]}]}],
            [10, {timestamp: 60, txs: [{txHash: 'tx2', trades: [{amountBought: 2n}]}]}]
        ])
        cache.addTxData(txData)
        expect(tsData.ledgers.min).toBe(5)
        expect(tsData.ledgers.max).toBe(10)
        expect(cache.lastCachedLedger).toBe(10)
        expect(tsData.trades).toEqual([{amountBought: 1n}, {amountBought: 2n}])
    })

    test('getTradesForPeriod returns trades in range', () => {
        const cache = createCache(createMockRpcConnector(), 60, 10)
        cache.timestampData.set(0, {trades: [{amountBought: 1n}], poolData: new Map()})
        cache.timestampData.set(60, {trades: [{amountBought: 2n}], poolData: new Map()})
        const trades = cache.getTradesForPeriod(0, 120)
        expect(trades).toEqual([{amountBought: 1n}, {amountBought: 2n}])
    })

    test('getPoolVolumesForPeriod returns pools data in range', () => {
        const cache = createCache(createMockRpcConnector(), 60, 10)
        const poolsData1 = new Map([['id1', {tokens: ['A'], reserves: [1n]}]])
        const poolsData2 = new Map([['id2', {tokens: ['B'], reserves: [2n]}]])
        cache.timestampData.set(0, {trades: [], poolData: poolsData1})
        cache.timestampData.set(60, {trades: [], poolData: poolsData2})
        const pools = cache.getPoolVolumesForPeriod(0, 120)
        expect(pools).toEqual([{tokens: ['A'], reserves: [1n], poolId: 'id1'}, {tokens: ['B'], reserves: [2n], poolId: 'id2'}])
    })

    test('updateCache calls rpcConnector methods and evicts expired', async () => {
        const rpc = createMockRpcConnector()
        const cache = createCache(rpc, 60, 1)
        cache.__processPoolData = jest.fn()
        cache.__evictExpired = jest.fn()
        const poolContracts = new Map([['id', createMockPoolProvider()]])
        await cache.updateCache(60, 1, poolContracts)
        expect(rpc.generateLedgerRanges).toHaveBeenCalled()
        expect(rpc.fetchTransactions).toHaveBeenCalled()
        expect(cache.poolContracts).toBe(poolContracts)
        expect(cache.__processPoolData).toHaveBeenCalled()
        expect(cache.__evictExpired).toHaveBeenCalled()
    })

    test('__evictExpired removes old entries', () => {
        const cache = createCache(createMockRpcConnector(), 60, 1)
        cache.timestampData.set(0, {})
        cache.timestampData.set(60, {})
        cache.timestampData.set(120, {})
        cache.__evictExpired()
        expect(cache.timestampData.size).toBe(1)
    })

    test('__ensureTimestampData creates new entry if missing', () => {
        const cache = createCache(createMockRpcConnector(), 60, 10)
        const tsData = cache.__ensureTimestampData(123)
        expect(tsData.trades).toEqual([])
        //poolData starts as null so the DEX-side guard can distinguish
        //"worker has never visited this period" (null) from "worker ran but
        //no pools applied" (empty Map). See hasPoolDataForPeriod.
        expect(tsData.poolData).toBeNull()
        expect(tsData.processedTxs instanceof Set).toBe(true)
        expect(tsData.ledgers.min).toBe(Infinity)
        expect(tsData.ledgers.max).toBe(0)
        expect(cache.timestampData.get(123)).toBe(tsData)
    })


    test('dispose clears worker timeout and sets disposed flag', () => {
        const cache = createCache(createMockRpcConnector(), 60, 10)
        expect(cache.__workerTimeout).toBeDefined()
        cache.dispose()
        expect(cache.__workerTimeout).toBeNull()
        expect(cache.__disposed).toBe(true)
    })

    test('dispose is idempotent', () => {
        const cache = createCache(createMockRpcConnector(), 60, 10)
        cache.dispose()
        cache.dispose() //second call should not throw
        expect(cache.__disposed).toBe(true)
        expect(cache.__workerTimeout).toBeNull()
    })

    test('should simulate transaction', async () => {
        const cache = createCache(createMockRpcConnector())
        await cache.updateTokenMeta(['CBQSUF57OYX4RIMCZV62DKN6JFOTEKPHIZASMJYOUOCNHGNG2P3XQLSE'], 'GDVZHC625I6YJRA5VM4UQWH4FYOFBY3HNLC2TCP5GQEFBPU7ZWUGAH3U')

        expect(cache.tokensMeta.get('CBQSUF57OYX4RIMCZV62DKN6JFOTEKPHIZASMJYOUOCNHGNG2P3XQLSE')).toEqual({decimals: 8})
    }, 300000)

    test('partial range failure preserves successfully-fetched lower-range data', async () => {
        const rpc = createMockRpcConnector()

        const cache = createCache(rpc, 60, 16)
        cache.dispose()

        //three parallel ledger ranges; the middle one fails.
        rpc.generateLedgerRanges.mockResolvedValueOnce([
            {from: 1000, to: 1100},
            {from: 1100, to: 1200},
            {from: 1200, to: 1300}
        ])
        rpc.fetchTransactions.mockImplementation(async (from, to, cb) => {
            if (from === 1000) {
                cb({txHash: 'tx-low', createdAt: 60, ledger: 1050})
                return
            }
            if (from === 1100) {
                throw new Error('RPC failure on middle range (simulated)')
            }
            if (from === 1200) {
                cb({txHash: 'tx-high', createdAt: 180, ledger: 1250})
            }
        })

        await cache.updateCache(60, 5, new Map())

        const slot60 = cache.timestampData.get(60)
        const slot180 = cache.timestampData.get(180)

        expect({
            slot60TradeCount: slot60?.trades.length ?? 0,
            slot180TradeCount: slot180?.trades.length ?? 0,
            lastCachedLedgerStaysBelowGap: cache.lastCachedLedger < 1100
        }).toEqual({
            //lower-range tx preserved
            slot60TradeCount: 1,
            //higher-range tx discarded — gap below it makes it unreliable
            slot180TradeCount: 0,
            //cursor stays below the gap so the next tick refetches it
            lastCachedLedgerStaysBelowGap: true
        })
    })

    test('hasPoolDataForPeriod treats null as missing and empty Map as loaded', () => {
        const cache = createCache(createMockRpcConnector(), 60, 16)
        cache.dispose()

        //slot 60 — worker never visited
        cache.timestampData.set(60, {
            trades: [],
            poolData: null,
            processedTxs: new Set(),
            ledgers: {min: 1, max: 100}
        })
        //slot 120 — worker visited but no pools applied
        cache.timestampData.set(120, {
            trades: [],
            poolData: new Map(),
            processedTxs: new Set(),
            ledgers: {min: 100, max: 200}
        })
        //slot 180 — worker visited and pools applied
        cache.timestampData.set(180, {
            trades: [],
            poolData: new Map([['pool1', {tokens: ['A'], reserves: [1n]}]]),
            processedTxs: new Set(),
            ledgers: {min: 200, max: 300}
        })

        expect({
            //null → not loaded
            slot60: cache.hasPoolDataForPeriod(60, 120),
            //empty Map → loaded
            slot120: cache.hasPoolDataForPeriod(120, 180),
            //populated Map → loaded
            slot180: cache.hasPoolDataForPeriod(180, 240),
            //all slots loaded → true
            range120to240: cache.hasPoolDataForPeriod(120, 240),
            //one null in range → false
            range60to180: cache.hasPoolDataForPeriod(60, 180),
            //missing slot → false
            range240to300: cache.hasPoolDataForPeriod(240, 300)
        }).toEqual({
            slot60: false,
            slot120: true,
            slot180: true,
            range120to240: true,
            range60to180: false,
            range240to300: false
        })
    })

})

describe('TxCache pool snapshots', () => {
    //an hour ahead, so a tick the worker schedules after a test never fires before afterEach disposes the cache
    const T = Math.floor(Date.now() / 60000) * 60 + 3600
    let cache = null

    afterEach(async () => {
        jest.clearAllMocks()
        if (cache)
            await cache.dispose()
        cache = null
    })

    /**
     * A cache with no scheduled tick, for driving __worker and __processPoolData directly
     * @param {object} [rpc] - RPC connector mock
     * @param {number} [size] - cache size
     * @returns {TxCache}
     */
    function stoppedCache(rpc = createMockRpcConnector(), size = 16) {
        cache = new TxCache(rpc, 60, size)
        clearTimeout(cache.__workerTimeout)
        cache.__workerTimeout = null
        return cache
    }

    function slot() {
        return {trades: [], poolData: null, processedTxs: new Set(), ledgers: {min: Infinity, max: 0}}
    }

    test('the constructor schedules the first tick for the next boundary, five seconds ahead', () => {
        jest.useFakeTimers({now: new Date('2026-09-27T12:10:30Z')})
        const worker = jest.spyOn(TxCache.prototype, '__worker').mockResolvedValue()
        try {
            cache = new TxCache(createMockRpcConnector(), 60, 16)
            jest.advanceTimersByTime(24999)
            expect(worker).not.toHaveBeenCalled()
            jest.advanceTimersByTime(1)
            expect(worker).toHaveBeenCalledWith(Date.parse('2026-09-27T12:11:00Z'))
        } finally {
            worker.mockRestore()
            jest.useRealTimers()
        }
    })

    test('the worker stages the snapshot for the period its boundary closes', async () => {
        const instances = new Map([['pool1', {xdr: 'x', lastModifiedLedgerSeq: 7}]])
        takePoolSnapshot.mockResolvedValueOnce({servedLedger: 101, instances})
        const c = stoppedCache()
        c.poolContracts = new Map([['pool1', createMockPoolProvider()]])
        await c.__worker(T * 1000)
        expect(takePoolSnapshot).toHaveBeenCalledWith(expect.objectContaining({contracts: ['pool1'], boundary: T, deadline: T * 1000 + 10000}))
        expect([...c.pendingPoolData.values()]).toEqual([{slot: T - 60, boundary: T, servedLedger: 101, poolData: instances}])
    })

    test('staged snapshots older than the cache keeps are dropped at staging', async () => {
        const instances = new Map([['pool1', {xdr: 'x', lastModifiedLedgerSeq: 7}]])
        takePoolSnapshot.mockResolvedValueOnce({servedLedger: 101, instances})
        const c = stoppedCache()
        c.poolContracts = new Map([['pool1', createMockPoolProvider()]])
        //older than the cache keeps once the new slot (T - 60) lands, so it would only ever be evicted unapplied
        const staleSlot = T - 60 - c.size * c.period - 60
        c.pendingPoolData.set(staleSlot, {slot: staleSlot, boundary: staleSlot + 60, servedLedger: 1, poolData: new Map()})
        await c.__worker(T * 1000)
        expect(c.pendingPoolData.has(staleSlot)).toBe(false)
        expect(c.pendingPoolData.get(T - 60)).toEqual({slot: T - 60, boundary: T, servedLedger: 101, poolData: instances})
    })

    test('the worker stages nothing when the snapshot failed', async () => {
        takePoolSnapshot.mockResolvedValueOnce({failure: 'ledger gap', firstPastBoundary: 103})
        const c = stoppedCache()
        c.poolContracts = new Map()
        await c.__worker(T * 1000)
        expect(c.pendingPoolData.size).toBe(0)
        expect(console.warn).toHaveBeenCalledWith(expect.objectContaining({msg: 'No pool snapshot for period', reason: 'ledger gap', boundary: T}))
    })

    test('the worker takes no snapshot before the pool contracts are known', async () => {
        const c = stoppedCache()
        await c.__worker(T * 1000)
        expect(takePoolSnapshot).not.toHaveBeenCalled()
        expect(c.pendingPoolData.size).toBe(0)
        expect(console.warn).toHaveBeenCalledWith(expect.objectContaining({msg: 'Pool contracts not known yet - no pool snapshot for period'}))
    })

    test('each staged snapshot fills its own slot, priced at its boundary, and no other slot', () => {
        const c = stoppedCache()
        const provider = createMockPoolProvider()
        c.poolContracts = new Map([['pool1', provider]])
        c.timestampData.set(T - 180, slot())
        c.pendingPoolData.set(T - 120, {slot: T - 120, boundary: T - 60, servedLedger: 95, poolData: new Map([['pool1', {xdr: 'x1', lastModifiedLedgerSeq: 3}]])})
        c.pendingPoolData.set(T - 60, {slot: T - 60, boundary: T, servedLedger: 107, poolData: new Map([['pool1', {xdr: 'x2', lastModifiedLedgerSeq: 3}]])})
        c.__processPoolData()
        //no backfill: an earlier period never receives a later reading
        expect(c.timestampData.get(T - 180).poolData).toBeNull()
        expect(c.timestampData.get(T - 120).poolData.get('pool1')).toEqual({reserves: [100n, 200n], tokens: ['A', 'B']})
        expect(c.timestampData.get(T - 60).poolData.get('pool1')).toEqual({reserves: [100n, 200n], tokens: ['A', 'B']})
        expect(provider.processPoolInstance).toHaveBeenNthCalledWith(1, 'x1', 'pool1', 'testnet', c.tokensMeta, 3, T - 60)
        expect(provider.processPoolInstance).toHaveBeenNthCalledWith(2, 'x2', 'pool1', 'testnet', c.tokensMeta, 3, T)
        expect(c.pendingPoolData.size).toBe(0)
    })

    test('a snapshot with no pools still gives its period a snapshot', () => {
        const c = stoppedCache()
        c.poolContracts = new Map()
        c.pendingPoolData.set(T - 60, {slot: T - 60, boundary: T, servedLedger: null, poolData: new Map()})
        c.__processPoolData()
        expect(c.timestampData.get(T - 60).poolData).toEqual(new Map())
        expect(c.hasPoolDataForPeriod(T - 60, T)).toBe(true)
    })

    //Review Focus
    test('a pool that left the tracked set before the snapshot was applied is skipped', () => {
        const c = stoppedCache()
        c.poolContracts = new Map()
        c.pendingPoolData.set(T - 60, {slot: T - 60, boundary: T, servedLedger: 107, poolData: new Map([['gone', {xdr: 'x', lastModifiedLedgerSeq: 3}]])})
        c.__processPoolData()
        expect(c.timestampData.get(T - 60).poolData.size).toBe(0)
    })

    test('a snapshot for a period older than the cache keeps does not survive the update', async () => {
        const rpc = createMockRpcConnector()
        rpc.generateLedgerRanges.mockResolvedValue([])
        const c = stoppedCache(rpc, 2)
        c.timestampData.set(T - 120, slot())
        c.timestampData.set(T - 60, slot())
        c.pendingPoolData.set(T - 600, {slot: T - 600, boundary: T - 540, servedLedger: 5, poolData: new Map()})
        await c.updateCache(60, 1, new Map())
        expect([...c.timestampData.keys()].sort((a, b) => a - b)).toEqual([T - 120, T - 60])
    })

    test('updateCache sets the pool set before the transaction backfill finishes', async () => {
        const rpc = createMockRpcConnector()
        let release = null
        rpc.generateLedgerRanges.mockReturnValueOnce(new Promise(resolve => {
            release = resolve
        }))
        const c = stoppedCache(rpc)
        const poolContracts = new Map([['pool1', createMockPoolProvider()]])
        const updating = c.updateCache(60, 1, poolContracts)
        //let updateCache reach the held-open backfill call
        await new Promise(resolve => setImmediate(resolve))
        expect(c.poolContracts).toBe(poolContracts)
        release([])
        await updating
    })

    test('whenIdle waits for the running tick', async () => {
        const c = stoppedCache()
        let release = null
        c.__tick = new Promise(resolve => {
            release = resolve
        })
        const idle = c.whenIdle()
        const pending = Symbol('pending')
        expect(await Promise.race([idle, Promise.resolve(pending)])).toBe(pending)
        release()
        await expect(idle).resolves.toBeUndefined()
    })
})