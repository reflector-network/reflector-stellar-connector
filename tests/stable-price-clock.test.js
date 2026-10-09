/*eslint-disable no-undef */
const {calculatePrice} = require('../src/pools/aqua/aqua-pool-helper')

console.debug = jest.fn()
console.info = jest.fn()
console.warn = jest.fn()
console.error = jest.fn()
console.log = jest.fn()

describe('calculatePrice amplification ramp', () => {
    //a pool whose A is ramping over the next hour - the window where the clock matters
    const periodTimestamp = 1780009200
    const reserves = [1200000000000000000n, 1000000000000000000n]
    const stableData = {
        initialA: 1000n,
        initialATime: BigInt(periodTimestamp - 3600),
        futureA: 2000n,
        futureATime: BigInt(periodTimestamp + 3600),
        fee: 30n
    }

    afterEach(() => jest.restoreAllMocks())

    test('two nodes with clocks minutes apart compute the same price', () => {
        jest.spyOn(Date, 'now').mockReturnValue((periodTimestamp - 120) * 1000)
        const early = calculatePrice(reserves, stableData, periodTimestamp)
        jest.spyOn(Date, 'now').mockReturnValue((periodTimestamp + 240) * 1000)
        const late = calculatePrice(reserves, stableData, periodTimestamp)
        expect(early).toBe(late)
        expect(early).toBeGreaterThan(0n)
    })

    test('the ramp still moves with the period timestamp', () => {
        const atStart = calculatePrice(reserves, stableData, periodTimestamp - 3000)
        const atEnd = calculatePrice(reserves, stableData, periodTimestamp + 3000)
        expect(atStart).not.toBe(atEnd)
    })

    test('a missing period timestamp is an error, not a silent clock read', () => {
        expect(() => calculatePrice(reserves, stableData)).toThrow('Period timestamp is required')
    })
})
