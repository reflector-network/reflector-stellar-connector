/*eslint-disable no-undef */
const {Networks, StrKey} = require('@stellar/stellar-sdk')

jest.mock('../src/pools/utils', () => {
    const actual = jest.requireActual('../src/pools/utils')
    return {
        ...actual,
        extractInstanceStorage: jest.fn(() => ({})),
        getContractInstanceValues: jest.fn()
    }
})

const {getContractInstanceValues} = require('../src/pools/utils')
const {extractAquaPoolData} = require('../src/pools/aqua/aqua-pool-helper')
const AquaPoolProvider = require('../src/pools/aqua/aqua-pool-provider')
const TxCache = require('../src/cache')
const {encodeAssetContractId} = require('../src/utils')

console.debug = jest.fn()
console.info = jest.fn()
console.warn = jest.fn()
console.error = jest.fn()
console.log = jest.fn()

const TOKEN_A = StrKey.encodeContract(Buffer.alloc(32, 1))
const TOKEN_B = StrKey.encodeContract(Buffer.alloc(32, 2))
const POOL = StrKey.encodeContract(Buffer.alloc(32, 3))

describe('extractAquaPoolData decimals provenance', () => {
    beforeEach(() => jest.clearAllMocks())

    test('uses the decimals reported by the token contracts', () => {
        getContractInstanceValues.mockReturnValue({ReserveA: 1000n, ReserveB: 2000n, Tokens: [TOKEN_A, TOKEN_B]})
        const meta = new Map([[TOKEN_A, {decimals: 7}], [TOKEN_B, {decimals: 7}]])
        const poolData = extractAquaPoolData('XDR', meta)
        expect(poolData.tokens).toEqual([TOKEN_A, TOKEN_B])
        expect(poolData.reserves).toEqual([1000n * 10n ** 7n, 2000n * 10n ** 7n])
    })

    test('rejects a pool whose declared decimals disagree with the token contract', () => {
        getContractInstanceValues.mockReturnValue({ReserveA: 1000n, ReserveB: 2000n, Tokens: [TOKEN_A, TOKEN_B], Decimals: [0, 18]})
        const meta = new Map([[TOKEN_A, {decimals: 7}], [TOKEN_B, {decimals: 7}]])
        expect(extractAquaPoolData('XDR', meta)).toBeNull()
        expect(console.warn).toHaveBeenCalled()
    })

    test('accepts declared decimals for a token with no metadata, and rejects nonsense', () => {
        getContractInstanceValues.mockReturnValue({ReserveA: 1000n, ReserveB: 2000n, Tokens: [TOKEN_A, TOKEN_B], Decimals: [8, 8]})
        expect(extractAquaPoolData('XDR', new Map()).reserves).toEqual([1000n * 10n ** 6n, 2000n * 10n ** 6n])
        getContractInstanceValues.mockReturnValue({ReserveA: 1000n, ReserveB: 2000n, Tokens: [TOKEN_A, TOKEN_B], Decimals: [8, 99]})
        expect(extractAquaPoolData('XDR', new Map())).toBeNull()
    })

    test('rejects a pool whose tokens are not contract ids', () => {
        getContractInstanceValues.mockReturnValue({ReserveA: 1000n, ReserveB: 2000n, Tokens: ['TOKEN_A', 'TOKEN_B']})
        expect(extractAquaPoolData('XDR', new Map())).toBeNull()
    })

    test('still rejects a pool whose token metadata failed to load', () => {
        getContractInstanceValues.mockReturnValue({ReserveA: 1000n, ReserveB: 2000n, Tokens: [TOKEN_A, TOKEN_B]})
        const meta = new Map([[TOKEN_A, {decimals: 7}], [TOKEN_B, {failedAt: Date.now()}]])
        expect(extractAquaPoolData('XDR', meta)).toBeNull()
    })
})

describe('AquaPoolProvider provenance', () => {
    let provider

    beforeEach(() => {
        jest.clearAllMocks()
        provider = new AquaPoolProvider()
        provider.__cached = [{address: POOL, assets: [TOKEN_B, TOKEN_A], type: 'constant_product'}]
        provider.__lastUpdated = Number.MAX_SAFE_INTEGER //no refresh during the test
    })

    test('serves pubnet only', async () => {
        expect(await provider.getTargetPools('XLM', ['AQUA:GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA'], Networks.TESTNET)).toEqual([])
    })

    test('rejects an instance whose tokens are not the declared pair', () => {
        provider.__declaredTokens = new Map([[POOL, [TOKEN_A, TOKEN_B].sort()]])
        getContractInstanceValues.mockReturnValue({
            ReserveA: 1000n,
            ReserveB: 2000n,
            Tokens: [TOKEN_A, StrKey.encodeContract(Buffer.alloc(32, 9))]
        })
        expect(provider.processPoolInstance('XDR', POOL, Networks.PUBLIC, new Map(), 123, 1780009200)).toBeNull()
        expect(console.warn).toHaveBeenCalled()
    })

    test('accepts an instance that matches the declared pair', () => {
        provider.__declaredTokens = new Map([[POOL, [TOKEN_A, TOKEN_B].sort()]])
        getContractInstanceValues.mockReturnValue({ReserveA: 1000n, ReserveB: 2000n, Tokens: [TOKEN_A, TOKEN_B]})
        const result = provider.processPoolInstance('XDR', POOL, Networks.PUBLIC, new Map(), 123, 1780009200)
        expect(result.tokens).toEqual([TOKEN_A, TOKEN_B])
    })

    test('rejects a pool it never saw in the API list', () => {
        provider.__declaredTokens = new Map()
        getContractInstanceValues.mockReturnValue({ReserveA: 1000n, ReserveB: 2000n, Tokens: [TOKEN_A, TOKEN_B]})
        expect(provider.processPoolInstance('XDR', POOL, Networks.PUBLIC, new Map(), 123, 1780009200)).toBeNull()
    })
})

describe('TxCache.updateTokenMeta classic assets', () => {
    test('registers the 7 decimals of a classic asset SAC without an RPC call', async () => {
        const connector = {
            network: Networks.PUBLIC,
            getLedgerInfo: () => Promise.resolve({latestLedgerCloseTime: Math.floor(Date.now() / 1000) + 3600, latestLedger: 100}),
            loadPoolSnapshot: () => Promise.resolve(null),
            generateLedgerRanges: () => Promise.resolve([]),
            fetchTransactions: () => Promise.resolve(),
            simulateTransaction: jest.fn()
        }
        const cache = new TxCache(connector, 60, 16)
        try {
            await cache.updateTokenMeta(['XLM', 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'], 'GDLMOS3LF2CRRFCWDJ6TX3YIEYBBTZGAF3BSSEXOXFZWYHSCOHT6DRFX')
            expect(connector.simulateTransaction).not.toHaveBeenCalled()
            expect(cache.tokensMeta.get(encodeAssetContractId('XLM', Networks.PUBLIC))).toEqual({decimals: 7})
        } finally {
            await cache.dispose()
        }
    })
})
