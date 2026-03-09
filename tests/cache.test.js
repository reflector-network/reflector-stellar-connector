/*eslint-disable no-undef */
const RpcConnector = require('../src/rpc-connector')
const TxCache = require('../src/cache')

//Mocks
const mockNormalizeTimestamp = jest.fn((ts, period) => Math.floor(ts / period) * period)
jest.mock('../src/utils', () => ({
    normalizeTimestamp: (...args) => mockNormalizeTimestamp(...args)
}))
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
    beforeEach(() => {
        jest.clearAllMocks()
    })

    test('constructor initializes properties', () => {
        const rpc = createMockRpcConnector()
        const cache = new TxCache(rpc, 60, 10)
        expect(cache.size).toBe(10)
        expect(cache.period).toBe(60)
        expect(cache.network).toBe('testnet')
        expect(cache.rpcConnector).toBe(rpc)
        expect(cache.timestampData instanceof Map).toBe(true)
        expect(cache.poolContracts instanceof Map).toBe(true)
    })

    test('addTx adds transaction and updates lastCachedLedger', () => {
        mockNormalizeTimestamp.mockReturnValue(60)
        const cache = new TxCache(createMockRpcConnector(), 60, 10)
        cache.__ensureTimestampData = jest.fn().mockReturnValue({
            trades: [],
            poolsData: new Map(),
            processedTxs: new Set(),
            ledgers: {min: Infinity, max: 0}
        })
        cache.addTx({txHash: 'tx1', createdAt: 1000, ledger: 5})
        expect(mockXdrParseResult).toHaveBeenCalled()
        expect(cache.lastCachedLedger).toBe(5)
    })

    test('addTx does not process already processed tx', () => {
        mockNormalizeTimestamp.mockReturnValue(60)
        const cache = new TxCache(createMockRpcConnector(), 60, 10)
        const tsData = {
            trades: [],
            poolsData: new Map(),
            processedTxs: new Set(['tx1']),
            ledgers: {min: Infinity, max: 0}
        }
        cache.__ensureTimestampData = jest.fn().mockReturnValue(tsData)
        cache.addTx({txHash: 'tx1', createdAt: 1000, ledger: 5})
        expect(mockXdrParseResult).not.toHaveBeenCalled()
    })

    test('addTxToPeriod updates trades and ledgers', () => {
        const cache = new TxCache(createMockRpcConnector(), 60, 10)
        const tsData = {
            trades: [],
            poolsData: new Map(),
            processedTxs: new Set(),
            ledgers: {min: Infinity, max: 0}
        }
        cache.__ensureTimestampData = jest.fn().mockReturnValue(tsData)
        cache.addTxToPeriod('tx1', [{amountBought: 1n}], 60, 5)
        expect(tsData.trades).toEqual([{amountBought: 1n}])
        expect(tsData.processedTxs.has('tx1')).toBe(true)
        expect(tsData.ledgers.min).toBe(5)
        expect(tsData.ledgers.max).toBe(5)
        cache.addTxToPeriod('tx2', [{amountBought: 2n}], 60, 10)
        expect(tsData.ledgers.max).toBe(10)
    })

    test('getTradesForPeriod returns trades in range', () => {
        const cache = new TxCache(createMockRpcConnector(), 60, 10)
        cache.timestampData.set(0, {trades: [{amountBought: 1n}], poolData: new Map()})
        cache.timestampData.set(60, {trades: [{amountBought: 2n}], poolData: new Map()})
        const trades = cache.getTradesForPeriod(0, 120)
        expect(trades).toEqual([{amountBought: 1n}, {amountBought: 2n}])
    })

    test('getPoolsDataForPeriod returns pools data in range', () => {
        const cache = new TxCache(createMockRpcConnector(), 60, 10)
        const poolsData1 = new Map([['id1', {tokens: ['A'], reserves: [1n]}]])
        const poolsData2 = new Map([['id2', {tokens: ['B'], reserves: [2n]}]])
        cache.timestampData.set(0, {trades: [], poolData: poolsData1})
        cache.timestampData.set(60, {trades: [], poolData: poolsData2})
        const pools = cache.getPoolsDataForPeriod(0, 120)
        expect(pools).toEqual([{tokens: ['A'], reserves: [1n]}, {tokens: ['B'], reserves: [2n]}])
    })

    test('updateCache calls rpcConnector methods and evicts expired', async () => {
        const rpc = createMockRpcConnector()
        const cache = new TxCache(rpc, 60, 1)
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
        const cache = new TxCache(createMockRpcConnector(), 60, 1)
        cache.timestampData.set(0, {})
        cache.timestampData.set(60, {})
        cache.timestampData.set(120, {})
        cache.__evictExpired()
        expect(cache.timestampData.size).toBe(1)
    })

    test('__ensureTimestampData creates new entry if missing', () => {
        const cache = new TxCache(createMockRpcConnector(), 60, 10)
        const tsData = cache.__ensureTimestampData(123)
        expect(tsData.trades).toEqual([])
        expect(tsData.poolData instanceof Map).toBe(true)
        expect(tsData.processedTxs instanceof Set).toBe(true)
        expect(tsData.ledgers.min).toBe(Infinity)
        expect(tsData.ledgers.max).toBe(0)
        expect(cache.timestampData.get(123)).toBe(tsData)
    })


    test('should simulate transaction', async () => {
        const cache = new TxCache(createMockRpcConnector())
        await cache.updateTokenMeta(['CBQSUF57OYX4RIMCZV62DKN6JFOTEKPHIZASMJYOUOCNHGNG2P3XQLSE'], 'GDVZHC625I6YJRA5VM4UQWH4FYOFBY3HNLC2TCP5GQEFBPU7ZWUGAH3U')

        expect(cache.tokensMeta.get('CBQSUF57OYX4RIMCZV62DKN6JFOTEKPHIZASMJYOUOCNHGNG2P3XQLSE')).toEqual({decimals: 8})
    }, 300000)
})