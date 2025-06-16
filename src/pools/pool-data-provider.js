const PoolType = require('./pool-type')

let lastUpdated = 0
let cached = null

/**
 * Load pool list from Aquarius API
 * @param {string} baseAsset - oracle base token
 * @return {{contract: string, type: string, token: string}[]}
 */
async function loadAquaPoolList(baseAsset) {
    try {
        let data = cached
        const trimmedTs = new Date().getTime() / 60 * 60 * 1000 //trim to hours in order to refresh every 60 minutes
        if (trimmedTs > lastUpdated) {
            data = cached = await fetch('https://amm-api.aqua.network/pools/?size=500')
                .then(res => res.json())
            lastUpdated = trimmedTs
        }
        if (data.next) {
            console.warn('Not all Aquarius pools loaded - paging required')
        }
        return data.items.map(pool => {
            let type
            switch (pool.pool_type) {
                case 'constant_product':
                    type = 'constant_product'
                    break
                case 'stable':
                    type = 'stableswap'
                    break
                default:
                    console.log('Aquarius pool type not supported: ' + pool.pool_type)
            }
            if (pool.swap_killed
                || !type
                || pool.tokens_str.length !== 2
            ) //skip pools that are killed, unsupported types or with more than 2 tokens
                return null
            if (!pool.tokens_str.includes(baseAsset)) //if baseAsset is a contract address; if it's a {code}-{issuer} string -- should be (!assets.includes(baseAsset))
                return null //skip pools that do not contain base asset

            return {
                contract: pool.address,
                type: PoolType.AQUA,
                asset: pool.tokens_str.find(t => t !== baseAsset),
                baseAssetIndex: pool.tokens_str.indexOf(baseAsset)
            }
        }).filter(value => !!value)
    } catch (error) {
        console.error('Error loading Aquarius pool list:', error)
        return []
    }
}

module.exports = {
    loadAquaPoolList
}
