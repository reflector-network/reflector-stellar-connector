const {parseStateData, encodeContractId} = require('../src/contract-state-parser')

const p0 = 'AAA3XgAAAAYAAAAAAAAAAdvnd/gMZMLtrqewi876IT+RRR6+HQzJvyT2cGu/5WpbAAAACQAAAYqeiqFAAAAAAAAAAAAAAAAAAAAACgAAAAAAAAAAAAAAAAAAAAEAAAAA'
const p1 = 'AAA3XgAAAAYAAAAAAAAAAdvnd/gMZMLtrqewi876IT+RRR6+HQzJvyT2cGu/5WpbAAAACQAAAYqeiqFAAAAAAAAAAAEAAAAAAAAACgAAAAAAAAAAAAAAAAAAAAIAAAAA'
const intitializedContractEntry = 'AAA3XgAAAAYAAAAAAAAAAdvnd/gMZMLtrqewi876IT+RRR6+HQzJvyT2cGu/5WpbAAAAFAAAAAEAAAATAAAAAKiBo7d/cSlWYS0N6p7xJqnO2HhkQK+0dS/lXoyP9q5yAAAAAQAAAAYAAAAOAAAABWFkbWluAAAAAAAAEgAAAAAAAAAA/aF0k5UmPmVHvqhC2oXkCv0x2LO+l24oS8644j1/7JAAAAAOAAAABmFzc2V0cwAAAAAAEAAAAAEAAAACAAAAEAAAAAEAAAACAAAADwAAAAdTdGVsbGFyAAAAABIAAAAB9ZN7MltP1DWUXWuG1DmMztW4jRhBerU1Cf2Y1JLTh2MAAAAQAAAAAQAAAAIAAAAPAAAAB1N0ZWxsYXIAAAAAEgAAAAG0NCggxZFDgFH2XcR+JFimHY+S4U8I9JW+bqo5+S2XlwAAAA4AAAAObGFzdF90aW1lc3RhbXAAAAAAAAUAAAGKnoqhQAAAAA4AAAAGcGVyaW9kAAAAAAAFAAAAAAcnDgAAAAASAAAAAbQ0KCDFkUOAUfZdxH4kWKYdj5LhTwj0lb5uqjn5LZeXAAAAAwAAAAEAAAASAAAAAfWTezJbT9Q1lF1rhtQ5jM7VuI0YQXq1NQn9mNSS04djAAAAAwAAAAAAAAAA'

const notInitializedContractEntry = 'AAA4YQAAAAYAAAAAAAAAAUmq/tR8mJftgV2KwxLBkoBE79yOHOxALnynwKsYfxu/AAAAFAAAAAEAAAATAAAAAKiBo7d/cSlWYS0N6p7xJqnO2HhkQK+0dS/lXoyP9q5yAAAAAAAAAAA='

console.log(encodeContractId('CBE2V7WUPSMJP3MBLWFMGEWBSKAEJ364RYOOYQBOPST4BKYYP4N37PEH'))

describe('parseStateData()', () => {
    test('Missing price data', () => {
        expect(() => parseStateData({prices: [p1]}))
            .toThrowError('Missing price data for 1 assets')
    })
    test('Parsed price data', () => {
        expect(parseStateData({prices: [p0, p1], contractEntry: intitializedContractEntry}))
            .toStrictEqual({
                admin: 'GD62C5ETSUTD4ZKHX2UEFWUF4QFP2MOYWO7JO3RIJPHLRYR5P7WJB2E2',
                lastTimestamp: 1694877000000n,
                prices: [1n, 2n]
            })
    })
    test('Missing data', () => {
        expect(parseStateData({prices: [], contractEntry: null}))
            .toStrictEqual({
                admin: null,
                lastTimestamp: 0n,
                prices: [],
                uninitialized: true
            })
    })
    test('Missing init data', () => {
        expect(parseStateData({prices: [], contractEntry: notInitializedContractEntry}))
            .toStrictEqual({
                admin: null,
                lastTimestamp: 0n,
                prices: [],
                uninitialized: true
            })
    })
})

describe('encodeContractId()', () => {
    test('Contract address encoding', () => {
        expect(encodeContractId('CAYC4TCQODC2LT52DVYRBY6D3M4L67AE3WSLQHSEMZOK6KUQDAJKJMGG'))
            .toEqual('AAAAATAuTFBwxaXPuh1xEOPD2zi/fATdpLgeRGZcryqQGBKk')
    })
})