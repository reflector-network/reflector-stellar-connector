//suites that need a live Stellar RPC (http://localhost:8003), the Aqua API and api.stellar.expert
module.exports = {
    testMatch: ['<rootDir>/tests/get-price.test.js', '<rootDir>/tests/*.live.test.js'],
    testPathIgnorePatterns: ['/node_modules/']
}
