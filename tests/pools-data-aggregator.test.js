/*eslint-disable no-undef */
const PoolsDataAggregator = require('../src/pools/pools-data-aggregator')

function stringify(obj) {
    return JSON.stringify(obj, (_key, value) => typeof value === 'bigint' ? value.toString() : value)
}

const poolsData = [
    {
        reserves: [ 39470111652889n, 12306401956706876n ],
        tokens: ['CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA', 'CAUIKL3IYGMERDRUN6YSCLWVAKIFG5Q4YJHUKM4S4NJZQIA3BAS6OJPK']
    },
    {
        reserves: [ 338499679383n, 105757379841521n ],
        tokens: ['CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA', 'CAUIKL3IYGMERDRUN6YSCLWVAKIFG5Q4YJHUKM4S4NJZQIA3BAS6OJPK']
    },
    {
        reserves: [ 0n, 0n ],
        tokens: ['CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA', 'CAUIKL3IYGMERDRUN6YSCLWVAKIFG5Q4YJHUKM4S4NJZQIA3BAS6OJPK']
    },
    {
        reserves: [ 75750294039n, 23462096233811n ],
        tokens: ['CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA', 'CAUIKL3IYGMERDRUN6YSCLWVAKIFG5Q4YJHUKM4S4NJZQIA3BAS6OJPK']
    }
]

describe('PoolsDataAggregator', () => {
    test('Aggregate pool data', () => {

        const aggregator = new PoolsDataAggregator('XLM', ['AQUA:GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA'], 'Public Global Stellar Network ; September 2015', 1)
        aggregator.processTokenReserves(poolsData)

        expect(aggregator.volumes.length).toBe(1)

        expect(aggregator.volumes[0].asset).toBe('AQUA:GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA')

        expect(stringify(aggregator.volumes.map(a => {
            if (!a) {
                return {
                    quoteVolume: 0n,
                    volume: 0n,
                    ts: 1
                }
            }
            return {
                quoteVolume: a.quoteVolume,
                volume: a.volume,
                ts: a.ts
            }
        }))).toStrictEqual(
            stringify(poolsData.reduce((acc, item) => {
                acc[0].volume += item.reserves[0]
                acc[0].quoteVolume += item.reserves[1]
                return acc
            }, [{quoteVolume: 0n, volume: 0n, ts: 1}]))
        )
    })
})