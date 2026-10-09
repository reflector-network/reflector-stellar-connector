/**
 * @typedef {import('./rpc-connector')} RpcConnector
 */

//ledgers close about every 5 s, so polling at this pace sees every ledger in normal operation
const pollInterval = 500

/**
 * Why a tick has no snapshot
 */
const SnapshotFailure = {
    noProvenRead: 'no proven read',
    ledgerGap: 'ledger gap',
    noLedgerPastBoundary: 'no ledger past the boundary',
    cancelled: 'cancelled'
}

/**
 * @param {number} ms - milliseconds
 * @return {Promise<void>}
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * @param {RpcConnector} rpcConnector - RPC connector
 * @return {Promise<{ledger: number, closeTime: number}|null>} the latest ledger and its close time, null when unusable
 */
async function readLedgerInfo(rpcConnector) {
    try {
        const info = await rpcConnector.getLedgerInfo()
        const ledger = Number(info?.latestLedger)
        const closeTime = Number(info?.latestLedgerCloseTime)
        if (Number.isSafeInteger(ledger) && ledger > 0 && Number.isFinite(closeTime) && closeTime > 0)
            return {ledger, closeTime}
        console.warn({msg: 'Unusable ledger info from RPC', network: rpcConnector.network})
    } catch (err) {
        console.warn({msg: 'Unable to load ledger info', network: rpcConnector.network, err})
    }
    return null
}

/**
 * @param {RpcConnector} rpcConnector - RPC connector
 * @param {string[]} contracts - pools to read
 * @return {Promise<{instances: Map, servedLedger: number}|null>} the read, null when it failed or was discarded
 */
async function readPools(rpcConnector, contracts) {
    try {
        return await rpcConnector.loadPoolSnapshot(contracts)
    } catch (err) {
        console.warn({msg: 'Unable to load pool entries', network: rpcConnector.network, err})
        return null
    }
}

/**
 * Read the pools' state at the last ledger that closed before a period boundary, and prove it is that ledger. A ledger
 * closing exactly at the boundary belongs to the next period, as its trades do (a trade is bucketed by its close time
 * rounded down). A read at ledger N is inside the period once a ledger at or after N is seen closing before the
 * boundary, because close times rise with the sequence. It is the period's last ledger when the first ledger seen
 * closing at or after the boundary is N + 1. The proof uses only ledger numbers and close times, which are the same on
 * every RPC server, so it holds whichever URL answered which call
 * @param {object} options - pool snapshot options
 * @param {RpcConnector} options.rpcConnector - RPC connector
 * @param {string[]} options.contracts - pools to read; an empty list needs only a ledger past the boundary
 * @param {number} options.boundary - period boundary, unix seconds
 * @param {number} options.deadline - time to give up, ms
 * @param {function(): boolean} [options.isCancelled] - stops the tick when it returns true
 * @param {function(): number} [options.now] - clock, ms
 * @param {function(number): Promise<void>} [options.wait] - waits between polls
 * @return {Promise<object>} snapshot or failure
 */
async function takePoolSnapshot({rpcConnector, contracts, boundary, deadline, isCancelled = () => false, now = Date.now, wait = sleep}) {
    //the highest ledger seen closing before the boundary, and the first seen closing at or after it
    let highestInPeriod = 0
    let firstPastBoundary = 0
    //reads by the ledger they were served at; a ledger already read is not read again
    const reads = new Map()
    let lastReadLedger = 0
    while (now() < deadline) {
        if (isCancelled())
            return {failure: SnapshotFailure.cancelled}
        const info = await readLedgerInfo(rpcConnector)
        if (info) {
            if (info.closeTime >= boundary) {
                firstPastBoundary = info.ledger
                break
            }
            //an answer from a lagging URL must not lower it
            if (info.ledger > highestInPeriod)
                highestInPeriod = info.ledger
            if (contracts.length > 0 && info.ledger > lastReadLedger) {
                const read = await readPools(rpcConnector, contracts)
                if (read) {
                    reads.set(read.servedLedger, read.instances)
                    if (read.servedLedger > lastReadLedger)
                        lastReadLedger = read.servedLedger
                }
            }
        }
        await wait(pollInterval)
    }
    if (isCancelled())
        return {failure: SnapshotFailure.cancelled}
    if (!firstPastBoundary)
        return {failure: SnapshotFailure.noLedgerPastBoundary, highestInPeriod}
    if (contracts.length === 0)
        return {servedLedger: null, instances: new Map()}
    const lastInPeriod = firstPastBoundary - 1
    const instances = reads.get(lastInPeriod)
    if (instances && lastInPeriod <= highestInPeriod)
        return {servedLedger: lastInPeriod, instances}
    //a proven read of an earlier ledger means a ledger of the period was never read
    const readLedgers = [...reads.keys()]
    const failure = readLedgers.some(ledger => ledger < lastInPeriod && ledger <= highestInPeriod)
        ? SnapshotFailure.ledgerGap
        : SnapshotFailure.noProvenRead
    return {failure, firstPastBoundary, highestInPeriod, readLedgers}
}

module.exports = {takePoolSnapshot, SnapshotFailure}
