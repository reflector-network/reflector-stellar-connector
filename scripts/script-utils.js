/**
 * Shared helpers for the pool verification/comparison scripts.
 */
const {adjustPrecision} = require('../src/utils')

/**
 * @typedef {import('../src/rpc-connector')} RpcConnector
 */

const AQUA_API_HOST = 'amm-api.aqua.network'
//system account from the Reflector pubnet cluster, same default TxCache.updateTokenMeta uses
const SIM_SOURCE_ACCOUNT = 'GDLMOS3LF2CRRFCWDJ6TX3YIEYBBTZGAF3BSSEXOXFZWYHSCOHT6DRFX'

const one = adjustPrecision(1n, 0) //10^14

/**
 * Render a 14-decimal bigint as a human-readable decimal string
 * @param {BigInt} value - value scaled to 14 decimals
 * @return {string}
 */
function fmt(value) {
    const neg = value < 0n
    const abs = neg ? -value : value
    return `${neg ? '-' : ''}${abs / one}.${(abs % one).toString().padStart(14, '0').slice(0, 7)}`
}

/**
 * Create a single-result contract simulation helper bound to an RPC connector
 * @param {RpcConnector} rpc - RPC connector
 * @return {function} - (contract, fn, args) => Promise resolving the first simulation result
 */
function createSimulate(rpc) {
    return (contract, fn, args = []) => rpc.simulateTransaction(SIM_SOURCE_ACCOUNT, {function: fn, contract, args})
        .then(res => res[0])
}

/**
 * Load live 2-token Aqua pools of the given types from the Aquarius API
 * @param {string[]} types - pool_type values to include (e.g. ['stable', 'concentrated'])
 * @return {Promise<{address: string, type: string, tokens: string[], symbols: Map<string, string>}[]>}
 */
async function loadAquaPools(types) {
    const pools = []
    let url = `https://${AQUA_API_HOST}/pools/?size=500`
    while (url) {
        const response = await fetch(url).then(res => res.json())
        url = response.next && new URL(response.next).host === AQUA_API_HOST ? response.next : null
        for (const pool of response.items) {
            if (!types.includes(pool.pool_type) || pool.swap_killed || pool.tokens_addresses.length !== 2)
                continue
            const symbols = new Map()
            for (let i = 0; i < pool.tokens_addresses.length; i++) {
                symbols.set(pool.tokens_addresses[i], pool.tokens_str[i].split(':')[0])
            }
            pools.push({address: pool.address, type: pool.pool_type, tokens: pool.tokens_addresses, symbols})
        }
    }
    return pools
}

module.exports = {
    SIM_SOURCE_ACCOUNT,
    one,
    fmt,
    createSimulate,
    loadAquaPools
}
