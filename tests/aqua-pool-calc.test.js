/*eslint-disable no-undef */
const {calculatePrice, extractAquaPoolData} = require('../src/pools/aqua-pool-helper')
const RpcConnector = require('../src/rpc-connector')
const {TARGET_DECIMALS} = require('../src/utils')


function spotPriceLinear([x, y], idxIn = 0, amp) {
    const delta = idxIn === 0 ? x - y : y - x
    const S = x + y
    return 1 + delta * 2 / (S * amp)
}

function spotPriceLinearFee(balances, idxIn = 0, A = 1500n, feeBp = 1n) {
    const [x, y] = balances
    const delta = idxIn === 0 ? x - y : y - x
    const sum = x + y
    const feeKoef = 1 - Number(feeBp) / 10_000
    const price = 1 + Number(delta) * 2 / (Number(sum) * Number(A))
    return price * feeKoef
}

describe('Aqua Pool Provider', () => {
    it('should calculate the correct price', async () => {
        const response = await fetch('https://amm-api.aqua.network/pools/?size=500')
        const data = await response.json()
        const pools = data.items
            .filter(pool => pool.pool_type === 'stable')
            .map(pool => ({
                address: pool.address,
                tokens: [[pool.tokens_addresses[0], pool.tokens_str[0]], [pool.tokens_addresses[1], pool.tokens_str[1]]]
            }))

        const res = []
        const rpc = new RpcConnector(['http://localhost:8003'], 'Public Global Stellar Network ; September 2015')
        for (const pool of pools) {
            const poolInstances = await rpc.loadContractInstances([pool.address])
            const poolData = extractAquaPoolData(
                [...poolInstances.values()][0].xdr,
                pool.tokens[0][0],
                new Map([pool.tokens[1]])
            )
            if (!poolData)
                continue
            const {reserves, tokens, stableData} = poolData
            if (!reserves || reserves[0] === 0n || reserves[1] === 0n) {
                console.debug(`Skipping pool with zero reserves: ${pool.address}`)
                continue
            }
            if (stableData) {
                const price = calculatePrice(reserves, stableData)

                const computedVolumes = [price, 10n ** BigInt(TARGET_DECIMALS)]
                const aGtB = computedVolumes[0] > computedVolumes[1]
                res.push({
                    address: pool.address,
                    tokens: pool.tokens.map(t => t[1].split(':')[0]).join('-'),
                    price,
                    realReserves: reserves,
                    reserves: computedVolumes,
                    computedPrice: computedVolumes[0] * (10n ** BigInt(TARGET_DECIMALS)) / computedVolumes[1],
                    is: aGtB === reserves[0] > reserves[1] ? aGtB : '!!!'
                })
            }
        }

        console.table(res)
    })
})