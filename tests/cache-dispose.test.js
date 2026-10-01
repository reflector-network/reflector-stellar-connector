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
        //only the gated stub is `async` - the others return promises, because an `async` body with no `await` is a require-await warning
        const connector = {
            network: 'test',
            getLedgerInfo: () => Promise.resolve({latestLedgerCloseTime: Math.floor(Date.now() / 1000) + 3600, latestLedger: 100}),
            loadContractInstances: async () => {
                await gate
                return new Map([['pool1', {xdr: 'xdr', lastModifiedLedgerSeq: 50}]])
            },
            generateLedgerRanges: () => Promise.resolve([]),
            fetchTransactions: () => Promise.resolve()
        }
        const cache = new TxCache(connector, 60, 16)
        //let the tick reach loadContractInstances
        await new Promise(resolve => setImmediate(resolve))
        const disposal = cache.dispose()
        expect(cache.__disposed).toBe(true)
        expect(cache.__workerTimeout).toBeNull()
        const pending = Symbol('pending')
        //the tick is still running, so disposal must not have resolved yet
        expect(await Promise.race([disposal, Promise.resolve(pending)])).toBe(pending)
        release()
        await expect(disposal).resolves.toBeUndefined()
        expect(cache.pendingPoolData).toBeNull()
        expect(cache.__workerTimeout).toBeNull()
    })

    test('is idempotent and resolves when no tick is running', async () => {
        const connector = {
            network: 'test',
            getLedgerInfo: () => Promise.resolve({latestLedgerCloseTime: Math.floor(Date.now() / 1000) + 3600, latestLedger: 100}),
            loadContractInstances: () => Promise.resolve(new Map()),
            generateLedgerRanges: () => Promise.resolve([]),
            fetchTransactions: () => Promise.resolve()
        }
        const cache = new TxCache(connector, 60, 16)
        await cache.dispose()
        await expect(cache.dispose()).resolves.toBeUndefined()
        expect(cache.__disposed).toBe(true)
    })
})
