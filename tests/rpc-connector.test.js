/*eslint-disable no-undef */
const RpcConnector = require('../src/rpc-connector')
const {invokeRpcMethod} = require('../src/utils')

//Mocks
jest.mock('../src/utils', () => ({
    invokeRpcMethod: jest.fn()
}))

describe('RpcConnector.loadContractInstances', () => {
    let connector

    beforeEach(() => {
        connector = new RpcConnector(['http://rpc-url'], 'testnet')
        jest.clearAllMocks()
    })

    it('should return a map of contract IDs to their ledger entries', async () => {
        const contracts = ['CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA', 'CCKCKCPHYVXQD4NECBFJTFSCU2AMSJGCNG4O6K4JVRE2BLPR7WNDBQIQ']
        const mockEntries = [
            {key: 'AAAABgAAAAEltPzYWa7C+mNIQ4xImzw8EMmLbSG+T9PLMMtolT75dwAAABQAAAAB', xdr: 'xdr1', lastModifiedLedger: 1, liveUntilLedgerSeq: 10},
            {key: 'AAAABgAAAAGUJQnnxW8B8aQQSpmWQqaAySTCabjvK4msSaCt8f2aMAAAABQAAAAB', xdr: 'xdr2', lastModifiedLedger: 2, liveUntilLedgerSeq: 20}
        ]
        invokeRpcMethod.mockResolvedValueOnce({entries: mockEntries})

        const result = await connector.loadContractInstances(contracts)

        expect(invokeRpcMethod).toHaveBeenCalledWith(
            ['http://rpc-url'],
            'getLedgerEntries',
            {keys: ['AAAABgAAAAEltPzYWa7C+mNIQ4xImzw8EMmLbSG+T9PLMMtolT75dwAAABQAAAAB', 'AAAABgAAAAGUJQnnxW8B8aQQSpmWQqaAySTCabjvK4msSaCt8f2aMAAAABQAAAAB']}
        )
        expect(result).toBeInstanceOf(Map)
        expect(result.size).toBe(2)
        expect([...result.values()]).toEqual(mockEntries)
    })

    it('should retry up to 3 times on failure', async () => {
        const contracts = ['CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA']
        invokeRpcMethod
            .mockRejectedValueOnce(new Error('fail1'))
            .mockRejectedValueOnce(new Error('fail2'))
            .mockResolvedValueOnce({entries: [{key: 'mocked-xdr-key', xdr: 'xdr', lastModifiedLedger: 1, liveUntilLedgerSeq: 10}]})

        const result = await connector.loadContractInstances(contracts)
        expect(result.size).toBe(1)
        expect(invokeRpcMethod).toHaveBeenCalledTimes(3)
    })

    it('should throw error after 3 failed attempts', async () => {
        const contracts = ['CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA']
        invokeRpcMethod.mockRejectedValue(new Error('fail'))

        await expect(connector.loadContractInstances(contracts)).rejects.toThrow('Failed to load contracts data from RPC')
        expect(invokeRpcMethod).toHaveBeenCalledTimes(3)
    })

    it('should return empty map if no entries returned', async () => {
        const contracts = ['CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA']
        invokeRpcMethod.mockResolvedValueOnce({entries: []})

        const result = await connector.loadContractInstances(contracts)
        expect(result.size).toBe(0)
    })

    describe('RpcConnector.generateLedgerRanges', () => {
        let connector

        beforeEach(() => {
            connector = new RpcConnector(['http://rpc-url'])
            jest.clearAllMocks()
        })

        it('should split into rangeLimit ranges', async () => {
            connector.getLedgerInfo = jest.fn().mockResolvedValue({
                secondsPerLedger: 5,
                latestLedger: 1000
            })
            //firstLedgerToLoad = 1000 - ceil(50/5)*2 = 980, rangeSize=ceil(20/2)=10
            //range0=[980,989], range1=[990,999]
            const ranges = await connector.generateLedgerRanges(900, 50, 2, 2)
            expect(ranges).toHaveLength(2)
            expect(ranges[0]).toEqual({from: 980, to: 989})
            expect(ranges[1]).toEqual({from: 990, to: 999})
        })

        it('should split into rangeLimit ranges for larger data sets', async () => {
            connector.getLedgerInfo = jest.fn().mockResolvedValue({
                secondsPerLedger: 5,
                latestLedger: 1000
            })
            //firstLedgerToLoad = 1000 - ceil(600/5)*2 = 760, rangeSize=ceil(240/3)=80
            //range0=[760,839], range1=[840,919], range2=[920,999]
            const ranges = await connector.generateLedgerRanges(0, 600, 2, 3)
            expect(ranges).toHaveLength(3)
            expect(ranges[0]).toEqual({from: 760, to: 839})
            expect(ranges[1]).toEqual({from: 840, to: 919})
            expect(ranges[2]).toEqual({from: 920, to: 999})
        })

        it('should filter out invalid ranges when data is sparse', async () => {
            connector.getLedgerInfo = jest.fn().mockResolvedValue({
                secondsPerLedger: 10,
                latestLedger: 100
            })
            //firstLedgerToLoad = 100 - ceil(20/10)*2 = 96, rangeSize=ceil(4/3)=2
            //range0=[96,97], range1=[98,99], range2=[100,99] → invalid, filtered out
            const ranges = await connector.generateLedgerRanges(10, 20, 2, 3)
            expect(ranges).toHaveLength(2)
            expect(ranges[0]).toEqual({from: 96, to: 97})
            expect(ranges[1]).toEqual({from: 98, to: 99})
        })
    })

    describe('RpcConnector.getTransaction', () => {
        let connector

        beforeEach(() => {
            connector = new RpcConnector(['http://rpc-url'])
            jest.clearAllMocks()
        })

        it('should throw error if hash is not provided', async () => {
            await expect(connector.getTransaction()).rejects.toThrow('Transaction hash is required')
        })

        it('should call invokeRpcMethod with correct params', async () => {
            invokeRpcMethod.mockResolvedValueOnce({foo: 'bar'})
            const hash = 'abc123'
            const result = await connector.getTransaction(hash)
            expect(invokeRpcMethod).toHaveBeenCalledWith(['http://rpc-url'], 'getTransaction', {hash})
            expect(result).toEqual({foo: 'bar'})
        })
    })

    describe('RpcConnector.fetchTransactions', () => {
        let connector

        beforeEach(() => {
            connector = new RpcConnector(['http://rpc-url'])
            jest.clearAllMocks()
        })

        it('should process only successful transactions within range', async () => {
            const mockTxs = [
                {ledger: 5, status: 'SUCCESS', id: 1},
                {ledger: 6, status: 'FAILED', id: 2},
                {ledger: 7, status: 'SUCCESS', id: 3},
                {ledger: 8, status: 'SUCCESS', id: 4}
            ]
            invokeRpcMethod.mockResolvedValueOnce({transactions: mockTxs, cursor: null})
            const cb = jest.fn()
            await connector.fetchTransactions(5, 8, cb)
            expect(cb).toHaveBeenCalledTimes(3)
            expect(cb).toHaveBeenCalledWith(mockTxs[0])
            expect(cb).toHaveBeenCalledWith(mockTxs[2])
            expect(cb).toHaveBeenCalledWith(mockTxs[3])
        })

        it('should stop processing when ledger exceeds upper bound', async () => {
            const mockTxs = [
                {ledger: 5, status: 'SUCCESS', id: 1},
                {ledger: 9, status: 'SUCCESS', id: 2}
            ]
            invokeRpcMethod.mockResolvedValueOnce({transactions: mockTxs, cursor: null})
            const cb = jest.fn()
            await connector.fetchTransactions(5, 8, cb)
            expect(cb).toHaveBeenCalledTimes(1)
            expect(cb).toHaveBeenCalledWith(mockTxs[0])
        })

        it('should handle paginated transactions', async () => {
            const txsPage1 = [
                {ledger: 5, status: 'SUCCESS', id: 1}
            ]
            const txsPage2 = [
                {ledger: 6, status: 'SUCCESS', id: 2}
            ]
            invokeRpcMethod
                .mockResolvedValueOnce({transactions: txsPage1, cursor: 'next'})
                .mockResolvedValueOnce({transactions: txsPage2, cursor: null})
            const cb = jest.fn()
            await connector.fetchTransactions(5, 6, cb)
            expect(cb).toHaveBeenCalledTimes(2)
            expect(cb).toHaveBeenCalledWith(txsPage1[0])
            expect(cb).toHaveBeenCalledWith(txsPage2[0])
        })

        it('should not call callback if no transactions', async () => {
            invokeRpcMethod.mockResolvedValueOnce({transactions: [], cursor: null})
            const cb = jest.fn()
            await connector.fetchTransactions(1, 2, cb)
            expect(cb).not.toHaveBeenCalled()
        })
    })
})