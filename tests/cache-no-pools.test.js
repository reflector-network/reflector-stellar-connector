/*eslint-disable no-undef */
const TxCache = require('../src/cache')

console.debug = jest.fn()
console.info = jest.fn()
console.warn = jest.fn()
console.error = jest.fn()
console.log = jest.fn()

const noPools = 'Pool contracts not known yet - no pool snapshot for period'

function messages(mock) {
    return mock.mock.calls.map(([entry]) => entry?.msg)
}

describe('TxCache before any pool set is known', () => {
    beforeEach(() => jest.clearAllMocks())

    test('warns once, then logs the missing pool set at debug level until one arrives', async () => {
        const connector = {
            network: 'test',
            getLedgerInfo: () => Promise.resolve({latestLedgerCloseTime: Math.floor(Date.now() / 1000), latestLedger: 100}),
            loadPoolSnapshot: () => Promise.resolve(null),
            generateLedgerRanges: () => Promise.resolve([]),
            fetchTransactions: () => Promise.resolve()
        }
        const cache = new TxCache(connector, 60, 16)
        clearTimeout(cache.__workerTimeout)
        const boundary = Math.floor(Date.now() / 60000) * 60000 + 3600000
        try {
            //each tick schedules the next one; only the ticks run here matter
            for (const target of [boundary, boundary + 60000, boundary + 120000]) {
                await cache.__worker(target)
                clearTimeout(cache.__workerTimeout)
            }
            expect(messages(console.warn).filter(m => m === noPools)).toHaveLength(1)
            expect(messages(console.debug).filter(m => m === noPools)).toHaveLength(2)
        } finally {
            await cache.dispose()
        }
    })
})
