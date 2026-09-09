const {xdr, Address} = require('@stellar/stellar-sdk')
const {DEFAULT_DECIMALS, adjustPrecision} = require('../../utils')
const {extractInstanceStorage, getContractInstanceValues} = require('../utils')

//SushiSwap V3 factory contract on pubnet
const SUSHI_FACTORY = 'CD3KRKGDRVWPXVB3VXLUMQKMX6XZ6Q2H334IVZD4XXNAMKSRVQL5GLYF'

/**
 * Build a base64 ledger key for a factory GetPool lookup entry
 * @param {string} token0 - first token contract id
 * @param {string} token1 - second token contract id
 * @param {number} fee - fee tier (hundredths of a bip)
 * @return {string}
 */
function buildGetPoolLedgerKey(token0, token1, fee) {
    return xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({
            contract: new Address(SUSHI_FACTORY).toScAddress(),
            key: xdr.ScVal.scvVec([
                xdr.ScVal.scvSymbol('GetPool'),
                new Address(token0).toScVal(),
                new Address(token1).toScVal(),
                xdr.ScVal.scvU32(fee)
            ]),
            durability: xdr.ContractDataDurability.persistent
        })
    ).toXdr('base64')
}

/**
 * Decode the pool address from a factory GetPool ledger entry
 * @param {string} entryXdr - LedgerEntryData in base64 XDR
 * @return {string} - pool contract id
 */
function parseGetPoolEntry(entryXdr) {
    const data = xdr.LedgerEntryData.fromXdr(entryXdr, 'base64')
    return Address.fromScVal(data.value.val).toString()
}

/**
 * Processes SushiSwap V3 pool contract instances
 * @param {string} contractData - contract instance entry in base64 XDR
 * @param {Map<string, {decimals: number}>} tokenMeta - Metadata for tokens to aggregate pools data for
 * @return {{reserves: BigInt[], tokens: string[], concentratedData: {sqrtPriceX96: bigint, digits: number[]}}|null}
 */
function extractSushiPoolData(contractData, tokenMeta) {
    const storage = getContractInstanceValues(extractInstanceStorage(contractData), ['params', 'pstate', 'bline'])
    if (!storage.params || !storage.pstate || !storage.bline)
        return null //not a SushiSwap pool instance
    const tokens = [storage.params.token0, storage.params.token1]
    if (new Set(tokens).size !== 2)
        return null
    const sqrtPriceX96 = storage.pstate.slot0?.sqrt_price_x96
    if (sqrtPriceX96 === undefined)
        return null
    const digits = tokens.map(t => {
        const meta = tokenMeta.get(t)
        return meta ? meta.decimals : DEFAULT_DECIMALS
    })
    if (digits.some(d => isNaN(d)))
        return null //unable to determine decimals
    const reserves = [
        adjustPrecision(BigInt(storage.bline.balance0), digits[0]),
        adjustPrecision(BigInt(storage.bline.balance1), digits[1])
    ]
    return {reserves, tokens, concentratedData: {sqrtPriceX96: BigInt(sqrtPriceX96), digits}}
}

module.exports = {
    SUSHI_FACTORY,
    buildGetPoolLedgerKey,
    parseGetPoolEntry,
    extractSushiPoolData
}
