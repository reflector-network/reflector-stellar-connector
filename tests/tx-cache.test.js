/*eslint-disable no-undef */
const {xdr} = require('@stellar/stellar-sdk')
const TxCache = require('../src/cache')
const {normalizeTimestamp} = require('../src/utils')

function buildFailedTxResultXdr() {
    return new xdr.TransactionResult({
        feeCharged: 100n,
        result: xdr.TransactionResultResult.txTooLate(),
        ext: xdr.TransactionResultExt.v0()
    }).toXdr('base64')
}

describe('TxCache', () => {
    test('caches txs with unparseable results as zero trades instead of crashing', async () => {
        const createdAt = Math.floor(Date.now() / 1000)
        const stubConnector = {
            network: 'test',
            //resolve immediately so the constructor worker exits on the first iteration
            getLedgerInfo: async () => ({latestLedgerCloseTime: createdAt + 60, latestLedger: 1}),
            loadContractInstances: async () => new Map(),
            generateLedgerRanges: async () => [{from: 1, to: 1}],
            //xdrParseResult returns null for this tx — the cache must record it with zero trades
            fetchTransactions: async (from, to, cb) => cb({createdAt, txHash: 'aa', ledger: 1, resultXdr: buildFailedTxResultXdr()})
        }
        const cache = new TxCache(stubConnector, 60, 16)
        try {
            await cache.updateCache(60, 5, new Map())
            expect(cache.lastCachedLedger).toBe(1)
            const slot = normalizeTimestamp(createdAt, 60)
            expect(cache.getTradesForPeriod(slot, slot + 60)).toEqual([])
            expect(cache.timestampData.get(slot).processedTxs.has('aa')).toBe(true)
        } finally {
            //give the constructor worker a chance to schedule its timer, then clear it
            await new Promise(resolve => setTimeout(resolve, 50))
            cache.dispose()
        }
    })
})
