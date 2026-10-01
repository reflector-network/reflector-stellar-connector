/*eslint-disable no-undef */
const http = require('http')
const {loadAquaPools} = require('../src/pools/aqua/aqua-api')

console.debug = jest.fn()
console.info = jest.fn()
console.warn = jest.fn()
console.error = jest.fn()
console.log = jest.fn()

const servers = []

/**
 * @param {function} handler - request handler
 * @returns {Promise<object>} listening server
 */
function startServer(handler) {
    return new Promise(resolve => {
        const server = http.createServer(handler)
        servers.push(server)
        server.listen(0, '127.0.0.1', () => resolve(server))
    })
}

/**
 * @param {object} server - listening server
 * @param {string} [path] - request path
 * @returns {string}
 */
function urlOf(server, path = '/pools/?size=500') {
    return `http://127.0.0.1:${server.address().port}${path}`
}

/**
 * @param {object} pool - pool overrides
 * @returns {object}
 */
function apiPool(pool) {
    return {
        address: 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526',
        tokens_addresses: [
            'CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF',
            'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75'
        ],
        pool_type: 'constant_product',
        swap_killed: false,
        ...pool
    }
}

/**
 * @returns {string} everything the mocked console received, for URL-leak assertions
 */
function loggedText() {
    const mocks = [console.debug, console.info, console.warn, console.error, console.log]
    return mocks.flatMap(mock => mock.mock.calls).map(call => JSON.stringify(call)).join(' ')
}

afterEach(async () => {
    jest.clearAllMocks()
    await Promise.all(servers.splice(0).map(server => new Promise(resolve => {
        //the stalled-response test leaves an active connection, and server.close() waits for it forever
        server.closeAllConnections()
        server.close(resolve)
    })))
})

describe('loadAquaPools', () => {
    test('follows same-host pagination and normalizes pool types', async () => {
        const server = await startServer((req, res) => {
            res.writeHead(200, {'content-type': 'application/json'})
            if (req.url.startsWith('/pools/?page=2')) {
                res.end(JSON.stringify({items: [apiPool({pool_type: 'stable'})], next: null}))
                return
            }
            res.end(JSON.stringify({
                items: [apiPool({pool_type: 'concentrated'})],
                next: `http://127.0.0.1:${server.address().port}/pools/?page=2`
            }))
        })
        const pools = await loadAquaPools({baseUrl: urlOf(server)})
        expect(pools.map(p => p.type)).toEqual(['concentrated', 'stableswap'])
        expect(pools[0].assets).toHaveLength(2)
    })

    test('rejects a list whose next page is on another host, and never names either URL', async () => {
        //a list cut short would read as "these assets have no Aqua pools", so it must not be answered with
        const server = await startServer((req, res) => {
            res.writeHead(200, {'content-type': 'application/json'})
            res.end(JSON.stringify({items: [apiPool({})], next: 'https://evil.example/pools/?page=2'}))
        })
        const err = await loadAquaPools({baseUrl: urlOf(server)}).catch(e => e)
        expect(err.message).toMatch(/^Aqua pool list incomplete: next page is on another host/)
        const said = err.message + loggedText()
        expect(said).not.toContain('size=500')
        expect(said).not.toContain('evil.example/pools')
    })

    test('drops entries that are killed, mistyped or not two contract tokens', async () => {
        const server = await startServer((req, res) => {
            res.writeHead(200, {'content-type': 'application/json'})
            res.end(JSON.stringify({
                items: [
                    apiPool({swap_killed: true}),
                    apiPool({pool_type: 'weighted'}),
                    apiPool({tokens_addresses: ['CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF']}),
                    apiPool({address: 'not-a-contract'}),
                    apiPool({})
                ],
                next: null
            }))
        })
        const pools = await loadAquaPools({baseUrl: urlOf(server)})
        expect(pools).toHaveLength(1)
    })

    test('rejects a non-200 response', async () => {
        const server = await startServer((req, res) => {
            res.writeHead(503, {'content-type': 'text/html'})
            res.end('<html>down</html>')
        })
        await expect(loadAquaPools({baseUrl: urlOf(server)})).rejects.toThrow('Aqua API responded with 503')
    })

    test('rejects a body without an items array', async () => {
        const server = await startServer((req, res) => {
            res.writeHead(200, {'content-type': 'application/json'})
            res.end(JSON.stringify({detail: 'nope'}))
        })
        await expect(loadAquaPools({baseUrl: urlOf(server)})).rejects.toThrow('Aqua API response has no items array')
    })

    test('rejects a body over the size cap', async () => {
        const server = await startServer((req, res) => {
            res.writeHead(200, {'content-type': 'application/json', 'transfer-encoding': 'chunked'})
            let written = 0
            const timer = setInterval(() => {
                res.write('x'.repeat(1024))
                if (++written > 20) {
                    clearInterval(timer)
                    res.end()
                }
            }, 1)
        })
        await expect(loadAquaPools({baseUrl: urlOf(server), maxBytes: 4096})).rejects.toThrow('Aqua API response is too large')
    })

    test('abandons a stalled response at the deadline', async () => {
        //headers arrive, the body never does - the deadline has to cover the body read, not just the fetch
        const server = await startServer((req, res) => {
            res.writeHead(200, {'content-type': 'application/json'})
            res.write('{')
        })
        const started = Date.now()
        await expect(loadAquaPools({baseUrl: urlOf(server), timeout: 300})).rejects.toThrow('Aqua API request timed out')
        expect(Date.now() - started).toBeLessThan(3000)
    })

    test('refuses to follow a redirect', async () => {
        const server = await startServer((req, res) => {
            res.writeHead(302, {location: 'http://169.254.169.254/latest/meta-data'})
            res.end()
        })
        await expect(loadAquaPools({baseUrl: urlOf(server)})).rejects.toThrow('Aqua API request failed')
    })

    test('rejects a list cut at the pool cap', async () => {
        const server = await startServer((req, res) => {
            res.writeHead(200, {'content-type': 'application/json'})
            res.end(JSON.stringify({items: [apiPool({}), apiPool({}), apiPool({})]}))
        })
        await expect(loadAquaPools({baseUrl: urlOf(server), maxPools: 2})).rejects.toThrow('Aqua pool list incomplete: more than 2 pools')
    })

    test('accepts a list of exactly the pool cap', async () => {
        const server = await startServer((req, res) => {
            res.writeHead(200, {'content-type': 'application/json'})
            res.end(JSON.stringify({items: [apiPool({}), apiPool({})]}))
        })
        expect(await loadAquaPools({baseUrl: urlOf(server), maxPools: 2})).toHaveLength(2)
    })

    test('rejects a list still paginating at the page cap', async () => {
        let pages = 0
        const server = await startServer((req, res) => {
            pages++
            res.writeHead(200, {'content-type': 'application/json'})
            res.end(JSON.stringify({
                items: [apiPool({})],
                next: `http://127.0.0.1:${server.address().port}/pools/?page=${pages + 1}`
            }))
        })
        await expect(loadAquaPools({baseUrl: urlOf(server), maxPages: 3})).rejects.toThrow('Aqua pool list incomplete: more than 3 pages')
        expect(pages).toBe(3)
    })
})
