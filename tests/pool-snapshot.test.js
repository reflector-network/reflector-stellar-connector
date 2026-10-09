/*eslint-disable no-undef */
const {takePoolSnapshot, SnapshotFailure} = require('../src/pool-snapshot')

console.debug = jest.fn()
console.info = jest.fn()
console.warn = jest.fn()
console.error = jest.fn()
console.log = jest.fn()

const T = 1790511060 //period boundary, unix seconds
const CONTRACTS = ['pool-a', 'pool-b']

/**
 * @param {number} latestLedger - ledger sequence
 * @param {number} secondsFromBoundary - its close time relative to T
 * @returns {{latestLedger: number, latestLedgerCloseTime: number}}
 */
function info(latestLedger, secondsFromBoundary) {
    return {latestLedger, latestLedgerCloseTime: T + secondsFromBoundary}
}

/**
 * A scripted RPC. Each getLedgerInfo call takes the next item of `infos` (the last one repeats); an Error item rejects.
 * Each loadPoolSnapshot call takes the next item of `reads`: `{servedLedger}`, `null` (a discarded read) or an Error.
 * Once `reads` is used up, a read is served at the ledger the latest info reported.
 * @param {Array<object|Error>} infos - ledger info answers
 * @param {Array<object|null|Error>} [reads] - pool read answers
 * @returns {object}
 */
function scriptedRpc(infos, reads = []) {
    let infoIndex = 0
    let readIndex = 0
    let lastLedger = 0
    return {
        network: 'test',
        getLedgerInfo: jest.fn(() => {
            const next = infos[Math.min(infoIndex++, infos.length - 1)]
            if (next instanceof Error)
                return Promise.reject(next)
            lastLedger = next.latestLedger
            return Promise.resolve(next)
        }),
        loadPoolSnapshot: jest.fn(() => {
            const next = readIndex < reads.length ? reads[readIndex++] : {servedLedger: lastLedger}
            if (next instanceof Error)
                return Promise.reject(next)
            if (next === null)
                return Promise.resolve(null)
            return Promise.resolve({servedLedger: next.servedLedger, instances: new Map([['pool-a', {xdr: `a@${next.servedLedger}`}]])})
        })
    }
}

/**
 * Run one tick on a clock that moves only when the tick waits, so it runs instantly and its deadline is exact
 * @param {object} rpc - scripted RPC
 * @param {object} [options] - test configuration
 * @returns {Promise<object>}
 */
function run(rpc, {contracts = CONTRACTS, startAt = T * 1000 - 5000, deadline = T * 1000 + 10000, isCancelled} = {}) {
    let clock = startAt
    return takePoolSnapshot({
        rpcConnector: rpc,
        contracts,
        boundary: T,
        deadline,
        isCancelled,
        now: () => clock,
        wait: ms => {
            clock += ms
            return Promise.resolve()
        }
    })
}

describe('takePoolSnapshot', () => {
    beforeEach(() => jest.clearAllMocks())

    test('keeps the read at the last ledger of the period once the next ledger closes after the boundary', async () => {
        const rpc = scriptedRpc([info(100, -8), info(101, -3), info(102, 2)])
        const result = await run(rpc)
        expect(result.servedLedger).toBe(101)
        expect(result.instances.get('pool-a')).toEqual({xdr: 'a@101'})
        expect(rpc.loadPoolSnapshot).toHaveBeenCalledTimes(2)
    })

    test('a ledger closing exactly at the boundary belongs to the next period, as its trades do', async () => {
        const rpc = scriptedRpc([info(100, -3), info(101, 0)])
        const result = await run(rpc)
        expect(result.servedLedger).toBe(100)
        expect(rpc.loadPoolSnapshot).toHaveBeenCalledTimes(1)
    })

    test('a ledger of the period that was never read leaves no snapshot', async () => {
        const rpc = scriptedRpc([info(100, -3), info(102, 2)])
        expect(await run(rpc)).toMatchObject({failure: SnapshotFailure.ledgerGap})
    })

    test('a tick that starts after the boundary has no proven read', async () => {
        const rpc = scriptedRpc([info(102, 2)])
        expect(await run(rpc)).toMatchObject({failure: SnapshotFailure.noProvenRead})
        expect(rpc.loadPoolSnapshot).not.toHaveBeenCalled()
    })

    test('a read served ahead of the ledger info is proven by a later answer', async () => {
        const rpc = scriptedRpc([info(100, -8), info(101, -3), info(102, 2)], [{servedLedger: 101}])
        const result = await run(rpc)
        expect(result.servedLedger).toBe(101)
        expect(rpc.loadPoolSnapshot).toHaveBeenCalledTimes(1)
    })

    test('a read ahead of every answer inside the period is not proven', async () => {
        const rpc = scriptedRpc([info(100, -3), info(101, 2)], [{servedLedger: 101}])
        expect(await run(rpc)).toMatchObject({failure: SnapshotFailure.noProvenRead})
    })

    test('a discarded read is read again at the same ledger', async () => {
        const rpc = scriptedRpc([info(101, -3), info(101, -3), info(102, 2)], [null])
        expect((await run(rpc)).servedLedger).toBe(101)
        expect(rpc.loadPoolSnapshot).toHaveBeenCalledTimes(2)
    })

    test('a failed read is retried on the next poll', async () => {
        const rpc = scriptedRpc([info(101, -3), info(101, -3), info(102, 2)], [new Error('rpc down')])
        expect((await run(rpc)).servedLedger).toBe(101)
        expect(rpc.loadPoolSnapshot).toHaveBeenCalledTimes(2)
    })

    test('an empty pool set needs only a ledger past the boundary', async () => {
        const rpc = scriptedRpc([info(101, -3), info(102, 2)])
        const result = await run(rpc, {contracts: []})
        expect(result.servedLedger).toBeNull()
        expect(result.instances.size).toBe(0)
        expect(rpc.loadPoolSnapshot).not.toHaveBeenCalled()
    })

    test('no ledger past the boundary by the deadline leaves no snapshot', async () => {
        const rpc = scriptedRpc([info(101, -3)])
        expect(await run(rpc)).toMatchObject({failure: SnapshotFailure.noLedgerPastBoundary})
    })

    test('a cancelled tick stops before asking anything', async () => {
        const rpc = scriptedRpc([info(101, -3)])
        expect(await run(rpc, {isCancelled: () => true})).toMatchObject({failure: SnapshotFailure.cancelled})
        expect(rpc.getLedgerInfo).not.toHaveBeenCalled()
    })

    test('unusable or failed ledger info is skipped', async () => {
        const rpc = scriptedRpc([{latestLedger: 'x', latestLedgerCloseTime: 'y'}, new Error('down'), info(101, -3), info(102, 2)])
        expect((await run(rpc)).servedLedger).toBe(101)
    })

    //Review Focus
    test('close times sent as strings are compared as numbers', async () => {
        const asStrings = [info(101, -3), info(102, 2)].map(i => ({
            latestLedger: i.latestLedger,
            latestLedgerCloseTime: String(i.latestLedgerCloseTime)
        }))
        expect((await run(scriptedRpc(asStrings))).servedLedger).toBe(101)
    })

    test('a tick that starts after its own deadline makes no request', async () => {
        const rpc = scriptedRpc([info(101, -3), info(102, 2)])
        const deadline = T * 1000 + 10000
        expect(await run(rpc, {startAt: deadline, deadline})).toMatchObject({failure: SnapshotFailure.noLedgerPastBoundary})
        expect(rpc.getLedgerInfo).not.toHaveBeenCalled()
    })

    test('an answer from a lagging RPC does not lower the highest ledger', async () => {
        const rpc = scriptedRpc([info(101, -3), info(100, -8), info(102, 2)])
        expect((await run(rpc)).servedLedger).toBe(101)
        expect(rpc.loadPoolSnapshot).toHaveBeenCalledTimes(1)
    })
})
