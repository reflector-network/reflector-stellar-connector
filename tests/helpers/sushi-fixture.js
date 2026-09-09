const {xdr, Address, nativeToScVal} = require('@stellar/stellar-sdk')

const FIXTURE_POOL = 'CAKWXQDEVVUF2ABUEM3M2G7QJGJNDZNNVXJZYG4Z4QP6K54QTWV4DW2S'
const FIXTURE_TOKEN0 = 'CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF'
const FIXTURE_TOKEN1 = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75'

function mapEntry(key, val) {
    return new xdr.ScMapEntry({key: xdr.ScVal.scvSymbol(key), val})
}

/**
 * Build a base64 LedgerEntryData for a SushiSwap pool contract instance
 * @param {object} [overrides] - sqrtPriceX96, balance0, balance1, token0, token1 overrides
 * @return {string}
 */
function buildSushiPoolInstance(overrides = {}) {
    const {
        sqrtPriceX96 = 2n ** 97n, //sqrt(price) = 2, price = 4.0 token1 per token0
        balance0 = 500000000n, //50.0 at 7 decimals
        balance1 = 1000000000n, //100.0 at 7 decimals
        token0 = FIXTURE_TOKEN0,
        token1 = FIXTURE_TOKEN1
    } = overrides
    const params = xdr.ScVal.scvMap([
        mapEntry('factory', new Address('CD3KRKGDRVWPXVB3VXLUMQKMX6XZ6Q2H334IVZD4XXNAMKSRVQL5GLYF').toScVal()),
        mapEntry('fee', xdr.ScVal.scvU32(500)),
        mapEntry('tick_spacing', xdr.ScVal.scvI32(10)),
        mapEntry('token0', new Address(token0).toScVal()),
        mapEntry('token1', new Address(token1).toScVal())
    ])
    const pstate = xdr.ScVal.scvMap([
        mapEntry('liquidity', nativeToScVal(73454788806576n, {type: 'u128'})),
        mapEntry('slot0', xdr.ScVal.scvMap([
            mapEntry('sqrt_price_x96', nativeToScVal(sqrtPriceX96, {type: 'u256'})),
            mapEntry('tick', xdr.ScVal.scvI32(13862))
        ]))
    ])
    const bline = xdr.ScVal.scvMap([
        mapEntry('balance0', nativeToScVal(balance0, {type: 'i128'})),
        mapEntry('balance1', nativeToScVal(balance1, {type: 'i128'}))
    ])
    const storage = [
        mapEntry('params', params),
        mapEntry('pstate', pstate),
        mapEntry('bline', bline),
        mapEntry('schema_v', xdr.ScVal.scvU32(1)) //extra key the extractor must tolerate
    ]
    const entry = xdr.LedgerEntryData.contractData(new xdr.ContractDataEntry({
        ext: xdr.ExtensionPoint.v0(),
        contract: new Address(FIXTURE_POOL).toScAddress(),
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent,
        val: xdr.ScVal.scvContractInstance(new xdr.ScContractInstance({
            executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.alloc(32)),
            storage
        }))
    }))
    return entry.toXdr('base64')
}

/**
 * Build a base64 LedgerEntryData for a factory GetPool entry pointing at a pool address
 * @param {string} factory - factory contract id
 * @param {string} token0 - first token contract id
 * @param {string} token1 - second token contract id
 * @param {number} fee - fee tier
 * @param {string} pool - pool contract id the entry resolves to
 * @return {string}
 */
function buildGetPoolEntry(factory, token0, token1, fee, pool) {
    const entry = xdr.LedgerEntryData.contractData(new xdr.ContractDataEntry({
        ext: xdr.ExtensionPoint.v0(),
        contract: new Address(factory).toScAddress(),
        key: xdr.ScVal.scvVec([
            xdr.ScVal.scvSymbol('GetPool'),
            new Address(token0).toScVal(),
            new Address(token1).toScVal(),
            xdr.ScVal.scvU32(fee)
        ]),
        durability: xdr.ContractDataDurability.persistent,
        val: new Address(pool).toScVal()
    }))
    return entry.toXdr('base64')
}

module.exports = {
    buildSushiPoolInstance,
    buildGetPoolEntry,
    FIXTURE_POOL,
    FIXTURE_TOKEN0,
    FIXTURE_TOKEN1
}
