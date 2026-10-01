/*eslint-disable no-undef */
const TxCache = require('../src/cache')

console.debug = jest.fn()
console.info = jest.fn()
console.warn = jest.fn()
console.error = jest.fn()
console.log = jest.fn()

describe('TxCache.dispose', () => {
    beforeEach(() => jest.clearAllMocks())

    test('waits for the in-flight tick, stages nothing and does not reschedule', async () => {
        let release = null
        const gate = new Promise(resolve => {
            release = resolve
        })
        //far enough ahead that the tick's deadline never passes during the test
        const boundary = Math.floor(Date.now() / 60000) * 60 + 3600
        //only the gated stub is `async` - the others return promises, because an `async` body with no `await` is a require-await warning
        const connector = {
            network: 'test',
            getLedgerInfo: () => Promise.resolve({latestLedgerCloseTime: boundary - 3, latestLedger: 100}),
            loadPoolSnapshot: jest.fn(async () => {
                await gate
                return {servedLedger: 100, instances: new Map([['pool1', {xdr: 'xdr', lastModifiedLedgerSeq: 50}]])}
            }),
            generateLedgerRanges: () => Promise.resolve([]),
            fetchTransactions: () => Promise.resolve()
        }
        const cache = new TxCache(connector, 60, 16)
        //the first tick is scheduled, not running: stop it and start one directly
        clearTimeout(cache.__workerTimeout)
        cache.poolContracts = new Map([['pool1', {}]])
        cache.__tick = cache.__worker(boundary * 1000)
        //let the tick reach loadPoolSnapshot
        await new Promise(resolve => setImmediate(resolve))
        expect(connector.loadPoolSnapshot).toHaveBeenCalledTimes(1)
        const disposal = cache.dispose()
        expect(cache.__disposed).toBe(true)
        expect(cache.__workerTimeout).toBeNull()
        const pending = Symbol('pending')
        //the tick is still running, so disposal must not have resolved yet
        expect(await Promise.race([disposal, Promise.resolve(pending)])).toBe(pending)
        release()
        await expect(disposal).resolves.toBeUndefined()
        expect(cache.pendingPoolData.size).toBe(0)
        expect(cache.__workerTimeout).toBeNull()
    })

    test('is idempotent and resolves when no tick is running', async () => {
        const connector = {
            network: 'test',
            getLedgerInfo: () => Promise.resolve({latestLedgerCloseTime: Math.floor(Date.now() / 1000) + 3600, latestLedger: 100}),
            loadPoolSnapshot: () => Promise.resolve(null),
            generateLedgerRanges: () => Promise.resolve([]),
            fetchTransactions: () => Promise.resolve()
        }
        const cache = new TxCache(connector, 60, 16)
        await cache.dispose()
        await expect(cache.dispose()).resolves.toBeUndefined()
        expect(cache.__disposed).toBe(true)
    })
})
