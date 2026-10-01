const {StrKey} = require('@stellar/stellar-sdk')

const AQUA_API_HOST = 'amm-api.aqua.network'
const AQUA_API_URL = `https://${AQUA_API_HOST}/pools/?size=500`
//a stalled pool-list request would stall the whole price tick, so every refresh is bounded on all four axes
const defaultTimeout = 10000
const defaultMaxBytes = 5 * 1024 * 1024
const defaultMaxPages = 20
const defaultMaxPools = 5000

const poolTypes = {
    constant_product: 'constant_product',
    stable: 'stableswap',
    concentrated: 'concentrated'
}

/**
 * Read a JSON body, refusing anything above the size cap
 * @param {Response} res - fetch response
 * @param {number} maxBytes - maximum accepted body size
 * @returns {Promise<any>}
 */
async function readCappedJson(res, maxBytes) {
    const declared = Number(res.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > maxBytes)
        throw new Error('Aqua API response is too large')
    if (!res.body)
        throw new Error('Aqua API response has no body')
    const reader = res.body.getReader()
    const chunks = []
    let size = 0
    try {
        for (;;) {
            const {done, value} = await reader.read()
            if (done)
                break
            size += value.length
            if (size > maxBytes)
                throw new Error('Aqua API response is too large')
            chunks.push(value)
        }
    } finally {
        reader.cancel().catch(err => console.debug({msg: 'Aqua API body cancel failed', err: err.message}))
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * Fetch and validate one page of the pool list
 * @param {string} url - page URL
 * @param {string} host - pinned API host, used for logging instead of the URL
 * @param {number} timeout - request deadline in milliseconds
 * @param {number} maxBytes - maximum accepted body size
 * @returns {Promise<{items: Array, next: (string|null)}>}
 */
async function fetchPage(url, host, timeout, maxBytes) {
    const abortController = new AbortController()
    const abortTimeout = setTimeout(() => abortController.abort(), timeout)
    let data
    try {
        const res = await fetch(url, {
            signal: abortController.signal,
            redirect: 'error', //a redirect would move the request off the pinned host
            headers: {accept: 'application/json'}
        })
        if (!res.ok)
            throw new Error(`Aqua API responded with ${res.status}`)
        //the body read stays inside the deadline: a server that sends headers and then stalls would otherwise hang forever
        data = await readCappedJson(res, maxBytes)
    } catch (err) {
        if (err.name === 'AbortError')
            throw new Error(`Aqua API request timed out after ${timeout} ms`)
        if (err.message.startsWith('Aqua API')) //already ours - status, size and body errors keep their wording
            throw err
        throw new Error(`Aqua API request failed: ${err.message}`)
    } finally {
        clearTimeout(abortTimeout)
    }
    if (!data || !Array.isArray(data.items))
        throw new Error('Aqua API response has no items array')
    if (data.next !== undefined && data.next !== null && typeof data.next !== 'string')
        throw new Error('Aqua API response has an invalid next link')
    console.debug({msg: 'Loaded Aqua pool page', host, items: data.items.length})
    return {items: data.items, next: data.next || null}
}

/**
 * Validate and normalize one pool entry from the API
 * @param {any} item - raw API item
 * @param {string} host - pinned API host, for logging
 * @returns {{address: string, assets: string[], type: string}|null}
 */
function parsePoolEntry(item, host) {
    if (!item || typeof item !== 'object')
        return null
    const type = poolTypes[item.pool_type]
    if (!type) {
        console.debug({msg: 'Aqua pool type not supported', host, poolType: item.pool_type})
        return null
    }
    if (item.swap_killed)
        return null
    const assets = item.tokens_addresses
    if (typeof item.address !== 'string'
        || !StrKey.isValidContract(item.address)
        || !Array.isArray(assets)
        || assets.length !== 2
        || assets[0] === assets[1]
        || !assets.every(a => typeof a === 'string' && StrKey.isValidContract(a)))
        return null
    return {address: item.address, assets, type}
}

/**
 * Load the Aqua pool list, following pagination only within the pinned host. A list that stops before its end - a next
 * page on another host, more pages or pools than the caps - rejects: cut short, it would read as "these assets have no
 * Aqua pools"
 * @param {{baseUrl: string, timeout: number, maxBytes: number, maxPages: number, maxPools: number}} [options] - request limits; tests override them, production uses the defaults
 * @returns {Promise<{address: string, assets: string[], type: string}[]>}
 */
async function loadAquaPools(options = {}) {
    const baseUrl = options.baseUrl || AQUA_API_URL
    const timeout = options.timeout || defaultTimeout
    const maxBytes = options.maxBytes || defaultMaxBytes
    const maxPages = options.maxPages || defaultMaxPages
    const maxPools = options.maxPools || defaultMaxPools
    const host = new URL(baseUrl).host
    const pools = []
    let url = baseUrl
    for (let page = 0; page < maxPages && url; page++) {
        const {items, next} = await fetchPage(url, host, timeout, maxBytes)
        for (const item of items) {
            const parsed = parsePoolEntry(item, host)
            if (!parsed)
                continue
            pools.push(parsed)
            if (pools.length > maxPools)
                throw new Error(`Aqua pool list incomplete: more than ${maxPools} pools (${host})`)
        }
        url = null
        if (next) {
            let nextHost = null
            try {
                nextHost = new URL(next).host
            } catch (err) {
                nextHost = null
            }
            if (nextHost !== host)
                throw new Error(`Aqua pool list incomplete: next page is on another host (${host})`)
            url = next
        }
    }
    if (url)
        throw new Error(`Aqua pool list incomplete: more than ${maxPages} pages (${host})`)
    console.debug({msg: 'Loaded Aqua pool list', host, count: pools.length})
    return pools
}

module.exports = {
    AQUA_API_HOST,
    AQUA_API_URL,
    loadAquaPools
}
