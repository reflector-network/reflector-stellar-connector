/*eslint-disable no-undef */
const RpcConnector = require('../src/rpc-connector')
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
        expect(pools).toEqual([{tokens: ['A'], reserves: [1n]}, {tokens: ['B'], reserves: [2n]}])
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
        expect(tsData.poolData instanceof Map).toBe(true)
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

    test('dispose prevents worker from rescheduling', async () => {
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
})