/*eslint-disable no-undef */
const {invokeRpcMethod} = require('../src/utils')

console.warn = jest.fn()

//a fetch per url: a url in `failing` rejects at once, as a hung url does once its 15 s deadline has passed
const mockRpc = {failing: new Set(), invalid: new Set(), requests: []}
global.fetch = jest.fn(url => {
    mockRpc.requests.push(url)
    if (mockRpc.failing.has(url))
        return Promise.reject(new Error('This operation was aborted'))
    return Promise.resolve({ok: true, json: () => Promise.resolve({result: {url, valid: !mockRpc.invalid.has(url)}})})
})

const tenMinutes = 10 * 60 * 1000
const call = urls => invokeRpcMethod(urls, 'getLatestLedger')

beforeEach(() => {
    mockRpc.failing = new Set()
    mockRpc.invalid = new Set()
    mockRpc.requests = []
})

//the preference is module state, so every test uses url lists of its own
describe('the rpc url that answered last is tried first', () => {
    test('a failing first url costs one request, not one per request', async () => {
        const urls = ['http://hung-a', 'http://good-a']
        mockRpc.failing.add('http://hung-a')

        await call(urls)
        await call(urls)

        expect(mockRpc.requests).toEqual(['http://hung-a', 'http://good-a', 'http://good-a'])
    })

    test('when the remembered url fails, the others are tried in configured order', async () => {
        const urls = ['http://first-b', 'http://second-b', 'http://third-b']
        mockRpc.failing.add('http://first-b')
        await call(urls)

        mockRpc.failing = new Set(['http://second-b'])
        mockRpc.requests = []
        await call(urls)
        await call(urls)

        expect(mockRpc.requests).toEqual(['http://second-b', 'http://first-b', 'http://first-b'])
    })

    test('each configured url list keeps its own preference', async () => {
        const listX = ['http://x1', 'http://x2']
        const listY = ['http://y1', 'http://y2']
        mockRpc.failing.add('http://x1')

        await call(listX)
        await call(listY)
        await call(listX)

        expect(mockRpc.requests).toEqual(['http://x1', 'http://x2', 'http://y1', 'http://x2'])
    })

    test('an answer that fails validation is not remembered', async () => {
        const urls = ['http://first-c', 'http://second-c']
        mockRpc.invalid.add('http://first-c')
        const validateResult = result => {
            if (!result.valid)
                throw new Error('invalid answer')
        }

        await invokeRpcMethod(urls, 'getLedgerEntries', undefined, {validateResult})
        mockRpc.invalid = new Set()
        mockRpc.requests = []
        await call(urls)

        //second-c answered validly and is preferred; first-c answered invalidly and is not
        expect(mockRpc.requests).toEqual(['http://second-c'])
    })

    test('a preference is dropped ten minutes after it was set, so the first url is tried again', async () => {
        const urls = ['http://primary-d', 'http://secondary-d']
        const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000)
        try {
            mockRpc.failing.add('http://primary-d')
            await call(urls)
            mockRpc.failing = new Set()
            now.mockReturnValue(1_000_000 + tenMinutes - 1)
            await call(urls)
            now.mockReturnValue(1_000_000 + tenMinutes)
            await call(urls)
            await call(urls)
        } finally {
            now.mockRestore()
        }
        expect(mockRpc.requests).toEqual(['http://primary-d', 'http://secondary-d', 'http://secondary-d', 'http://primary-d', 'http://primary-d'])
    })

    test('a preference is not extended while the same url keeps answering', async () => {
        const urls = ['http://primary-f', 'http://secondary-f']
        const now = jest.spyOn(Date, 'now').mockReturnValue(3_000_000)
        try {
            mockRpc.failing.add('http://primary-f')
            await call(urls)
            mockRpc.failing = new Set()
            for (const offset of [1, tenMinutes / 2, tenMinutes - 1]) {
                now.mockReturnValue(3_000_000 + offset)
                await call(urls)
            }
            now.mockReturnValue(3_000_000 + tenMinutes)
            await call(urls)
        } finally {
            now.mockRestore()
        }
        expect(mockRpc.requests).toEqual([
            'http://primary-f', 'http://secondary-f',
            'http://secondary-f', 'http://secondary-f', 'http://secondary-f',
            'http://primary-f'
        ])
    })
})

describe('a failed request fails as it did before the preference', () => {
    test('with a preference in place every url is still tried on each of the three attempts', async () => {
        const urls = ['http://one-g', 'http://two-g', 'http://three-g']
        mockRpc.failing.add('http://one-g')
        await call(urls)
        mockRpc.failing = new Set(urls)
        mockRpc.requests = []

        await expect(call(urls)).rejects.toThrow('Failed to invoke RPC method on all provided URLs')

        const attempt = ['http://two-g', 'http://one-g', 'http://three-g']
        expect(mockRpc.requests).toEqual([...attempt, ...attempt, ...attempt])
    })

    test('a failed request leaves the preference as it was', async () => {
        const urls = ['http://one-h', 'http://two-h']
        mockRpc.failing.add('http://one-h')
        await call(urls)
        mockRpc.failing = new Set(urls)
        await expect(call(urls)).rejects.toThrow('Failed to invoke RPC method on all provided URLs')
        mockRpc.failing = new Set()
        mockRpc.requests = []

        await call(urls)

        expect(mockRpc.requests).toEqual(['http://two-h'])
    })
})

describe('remembered url lists stay bounded', () => {
    test('the seventeenth list evicts the list that answered longest ago', async () => {
        const preferSecond = async name => {
            const urls = [`http://${name}-1`, `http://${name}-2`]
            mockRpc.failing.add(urls[0])
            await call(urls)
            mockRpc.failing.delete(urls[0])
            return urls
        }
        const oldest = await preferSecond('lru-old')
        const second = await preferSecond('lru-second')
        for (let i = 0; i < 15; i++)
            await preferSecond(`lru-fill-${i}`)
        mockRpc.requests = []

        await call(second)
        await call(oldest)

        expect(mockRpc.requests).toEqual(['http://lru-second-2', 'http://lru-old-1'])
    })
})
