/*eslint-disable no-undef */
const TxCache = require('../src/cache')

//Mocks
const mockXdrParseResult = jest.fn(() => [{amountBought: 1n, amountSold: 2n, assetBought: 'A', assetSold: 'B'}])
jest.mock('../src/dex/meta-processor', () => ({
    xdrParseResult: (...args) => mockXdrParseResult(...args)
}))
//mock console
console.debug = jest.fn()
console.info = jest.fn()
console.warn = jest.fn()
console.error = jest.fn()
console.log = jest.fn()

function createMockRpcConnector() {
    return {
        getLedgerInfo: jest.fn().mockResolvedValue({latestLedgerCloseTime: Date.now()}),
        loadContractInstances: jest.fn().mockResolvedValue({poolsData: new Map()}),
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
        expect(cache.poolContracts instanceof Map).toBe(true)
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

    test('dispose prevents worker from rescheduling', () => {
        const rpc = createMockRpcConnector()
        rpc.getLedgerInfo.mockResolvedValue({latestLedgerCloseTime: Math.floor(Date.now() / 1000) + 10})
        rpc.loadContractInstances.mockResolvedValue(new Map([['id', {xdr: 'xdr', lastModifiedLedgerSeq: 1}]]))
        const cache = createCache(rpc, 60, 10)
        cache.dispose()
        //after dispose, worker's finally block should not set a new timeout
        expect(cache.__workerTimeout).toBeNull()
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

    test('every minute slot should hold a pool snapshot after 5 successive updateCache ticks', async () => {
        const rpc = createMockRpcConnector()
        //pool is "unchanged" — lastModifiedLedgerSeq stays old (steady-state condition)
        const STALE_POOL_LEDGER = 1
        rpc.loadContractInstances = jest.fn().mockResolvedValue(
            new Map([['pool1', {xdr: 'pool1-xdr', lastModifiedLedgerSeq: STALE_POOL_LEDGER}]])
        )

        const cache = createCache(rpc, 60, 16)
        cache.dispose() //drive the cache directly — no worker rescheduling

        const poolContracts = new Map([['pool1', createMockPoolProvider()]])

        //5 PriceRunner-equivalent ticks
        let ledger = 100
        for (let minute = 1; minute <= 5; minute++) {
            cache.pendingPoolData = {
                timestamp: minute * 60,
                poolData: new Map([['pool1', {xdr: 'pool1-xdr', lastModifiedLedgerSeq: STALE_POOL_LEDGER}]])
            }

            //one tx per tick, lands in this minute's slot via __processTxData
            ledger += 10
            const tickLedger = ledger
            rpc.generateLedgerRanges.mockResolvedValueOnce([{from: tickLedger - 5, to: tickLedger}])
            rpc.fetchTransactions.mockImplementationOnce(async (from, to, cb) => {
                cb({txHash: `tx-min-${minute}`, createdAt: minute * 60, ledger: tickLedger})
            })

            await cache.updateCache(60, 5, poolContracts)
        }

        const distribution = []
        for (let minute = 1; minute <= 5; minute++) {
            const slot = cache.timestampData.get(minute * 60)
            distribution.push({
                minute,
                exists: !!slot,
                tradeCount: slot ? slot.trades.length : 0,
                poolCount: slot && slot.poolData ? slot.poolData.size : 0
            })
        }

        const slotsMissingPoolData = distribution
            .filter(d => d.exists && d.poolCount === 0)
            .map(d => d.minute)

        //every slot that saw a tick must hold pool data by oracle read time
        expect({slotsMissingPoolData, distribution}).toEqual({
            slotsMissingPoolData: [],
            distribution: expect.arrayContaining([expect.objectContaining({poolCount: expect.any(Number)})])
        })
    })

    test('iteration order with a mid-loop updated pool still attaches stable pools to the previous slot (fix verification)', () => {
        //97-pool iteration snapshot captured from a real worker tick — Map iteration order replays the production sequence
        const fixture = require('./fixtures/pool-iteration-snapshot.json')
        const order = fixture.tick0.map(e => e.poolId)
        expect(order).toHaveLength(97)

        const SLOT_PREV = 60 * 29 //previous-tick slot
        const SLOT_CURRENT = 60 * 30 //current-tick slot
        const L_PREV_MAX = 1000 //ledgers.max of previous slot
        const STALE_LEDGER = 500 //below L_PREV_MAX — back-attach target
        const NEW_LEDGER = 1500 //above L_PREV_MAX — current-slot-only

        //5 pools with lastModifiedLedgerSeq past L_PREV_MAX; the rest stale
        const updatedPools = new Set([
            'CBRXOYKXPQI4EEA6KA35TUIYN5OJLNWMTIVDOMNOIL2BG5Y5LEDHUU7V',
            '7a3b99b13f01fbb89754c9721b41aaafac773d0f6e222a7024aa9e4310a9debf',
            '461f6345f6b34f6b038f595ea282dad0b5fdcc15151186f2bb956a1a93bc430f',
            '59fa1dc57433dcfbd2db7319d26cb3da1f28f2d8095a3ec36ad4ef9cadb0013e',
            '5af87fae05b76e76c423fc1cc592a45828a0773afea0ba0e12aa92a58bfbb4e3'
        ])

        const rpc = createMockRpcConnector()
        const cache = createCache(rpc, 60, 16)
        cache.dispose() //drive __processPoolData directly — no worker scheduling

        //previous slot pre-populated: trades present, ledgers.max = L_PREV_MAX, no pool data attached
        cache.timestampData.set(SLOT_PREV, {
            trades: [{amountBought: 1n, amountSold: 1n, assetBought: 'A', assetSold: 'B'}],
            poolData: new Map(),
            processedTxs: new Set(),
            ledgers: {min: 1, max: L_PREV_MAX}
        })
        cache.__latestTimestamp = SLOT_PREV

        //build pendingPoolData in the captured iteration order
        const poolDataMap = new Map()
        const poolContracts = new Map()
        for (const poolId of order) {
            poolDataMap.set(poolId, {
                xdr: `xdr-${poolId}`,
                lastModifiedLedgerSeq: updatedPools.has(poolId) ? NEW_LEDGER : STALE_LEDGER
            })
            poolContracts.set(poolId, {
                processPoolInstance: jest.fn().mockReturnValue({
                    reserves: [100n, 200n],
                    tokens: [`tokA-${poolId.slice(0, 6)}`, `tokB-${poolId.slice(0, 6)}`]
                })
            })
        }
        cache.poolContracts = poolContracts
        cache.pendingPoolData = {timestamp: SLOT_CURRENT, poolData: poolDataMap}

        cache.__processPoolData()

        const slotPrevPools = cache.timestampData.get(SLOT_PREV).poolData
        const slotCurrentPools = cache.timestampData.get(SLOT_CURRENT)?.poolData ?? new Map()

        //position of the first updated pool — pre-fix, everything from this index onward flipped into the current slot only
        const firstBranchBIndex = order.findIndex(p => updatedPools.has(p))
        const before = order.slice(0, firstBranchBIndex)
        const after = order.slice(firstBranchBIndex)

        const beforeInSlotPrev = before.filter(p => slotPrevPools.has(p))
        const beforeInSlotCurrent = before.filter(p => slotCurrentPools.has(p))

        const stableAfter = after.filter(p => !updatedPools.has(p))
        const updatedAfter = after.filter(p => updatedPools.has(p))
        const stableAfterInSlotPrev = stableAfter.filter(p => slotPrevPools.has(p)).length
        const updatedAfterInSlotPrev = updatedAfter.filter(p => slotPrevPools.has(p)).length

        expect({
            firstBranchBIndex,
            firstBranchBPool: order[firstBranchBIndex],
            //stable pools land in both slots
            beforeAllInBothSlots: {
                inSlotPrev: beforeInSlotPrev.length,
                inSlotCurrent: beforeInSlotCurrent.length,
                expected: before.length
            },
            //stable pools after the trigger still back-attach to prev slot
            stableAfterTrigger: {
                count: stableAfter.length,
                inSlotPrev: stableAfterInSlotPrev,
                allInSlotCurrent: stableAfter.every(p => slotCurrentPools.has(p))
            },
            //updated pools reach current slot only (poolLedger > L_PREV_MAX)
            updatedAfterTrigger: {
                count: updatedAfter.length,
                inSlotPrev: updatedAfterInSlotPrev,
                allInSlotCurrent: updatedAfter.every(p => slotCurrentPools.has(p))
            }
        }).toEqual({
            firstBranchBIndex: 13,
            firstBranchBPool: 'CBRXOYKXPQI4EEA6KA35TUIYN5OJLNWMTIVDOMNOIL2BG5Y5LEDHUU7V',
            beforeAllInBothSlots: {inSlotPrev: 13, inSlotCurrent: 13, expected: 13},
            stableAfterTrigger: {count: 79, inSlotPrev: 79, allInSlotCurrent: true},
            updatedAfterTrigger: {count: 5, inSlotPrev: 0, allInSlotCurrent: true}
        })
    })

    test('partial range failure preserves successfully-fetched lower-range data', async () => {
        const rpc = createMockRpcConnector()
        //empty pool list makes the auto-worker early-return without staging
        //pendingPoolData, so __processPoolData is a no-op for this test.
        rpc.loadContractInstances = jest.fn().mockResolvedValue(new Map())

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

    test('__processPoolData populates slots after the first covering slot, even if their own pipeline failed', () => {
        const rpc = createMockRpcConnector()
        rpc.loadContractInstances = jest.fn().mockResolvedValue(new Map())
        const cache = createCache(rpc, 60, 16)
        cache.dispose()

        //before any covering slot — stays null
        cache.timestampData.set(60, {
            trades: [],
            poolData: null,
            processedTxs: new Set(),
            ledgers: {min: Infinity, max: 0}
        })
        //covering slot — populated by back-attach
        cache.timestampData.set(120, {
            trades: [],
            poolData: null,
            processedTxs: new Set(),
            ledgers: {min: 100, max: 200}
        })
        //after covering slot, own pipeline failed — populated by forward extension
        cache.timestampData.set(180, {
            trades: [],
            poolData: null,
            processedTxs: new Set(),
            ledgers: {min: Infinity, max: 0}
        })
        cache.__latestTimestamp = 180

        const STALE_POOL_LEDGER = 50 //< ledgers.max(120)=200
        cache.pendingPoolData = {
            timestamp: 240,
            poolData: new Map([['pool1', {xdr: 'xdr', lastModifiedLedgerSeq: STALE_POOL_LEDGER}]])
        }
        cache.poolContracts = new Map([['pool1', createMockPoolProvider()]])

        cache.__processPoolData()

        const has = (slot) => slot && slot.poolData ? slot.poolData.has('pool1') : false
        const slot60 = cache.timestampData.get(60)
        const slot120 = cache.timestampData.get(120)
        const slot180 = cache.timestampData.get(180)
        const slot240 = cache.timestampData.get(240)

        expect({
            //before any covering slot — stays null
            slot60PoolData: slot60.poolData,
            //covering slot — populated
            slot120HasPool1: has(slot120),
            //after covering slot — populated by forward extension
            slot180HasPool1: has(slot180),
            slot180PoolDataIsMap: slot180.poolData instanceof Map,
            //current slot always populated
            slot240HasPool1: has(slot240)
        }).toEqual({
            slot60PoolData: null,
            slot120HasPool1: true,
            slot180HasPool1: true,
            slot180PoolDataIsMap: true,
            slot240HasPool1: true
        })
    })
})