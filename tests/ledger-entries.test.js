/*eslint-disable no-undef */
const http = require('http')
const RpcConnector = require('../src/rpc-connector')

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
 * @returns {string}
 */
function urlOf(server) {
    return `http://127.0.0.1:${server.address().port}`
}

/**
 * @param {object} result - JSON-RPC result to answer with
 * @returns {Promise<object>} a listening server that answers every request with this result
 */
function answerWith(result) {
    return startServer((req, res) => {
        //drain the request body without keeping it - the answer is the same whatever was posted
        req.resume()
        req.on('end', () => {
            res.writeHead(200, {'content-type': 'application/json'})
            res.end(JSON.stringify({jsonrpc: '2.0', id: 8675309, result}))
        })
    })
}

afterEach(async () => {
    jest.clearAllMocks()
    await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
})

describe('getLedgerEntries responses', () => {
    test('a response without an entries array is a failed URL, not an empty pool set', async () => {
        const broken = await answerWith({latestLedger: 120})
        const connector = new RpcConnector([urlOf(broken)], 'net')
        await expect(connector.loadLedgerEntries(['k'])).rejects.toThrow('Failed to invoke RPC method')
    })
})
