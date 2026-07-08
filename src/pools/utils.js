const {xdr} = require('@stellar/stellar-sdk')

function extractInstanceStorage(instance) {
    let storageData = null
    try {
        storageData = xdr.LedgerEntryData.fromXDR(instance, 'base64')
    } catch (e) {
        try {
            storageData = xdr.LedgerEntryData.contractData(xdr.ContractDataEntry.fromXDR(instance, 'base64'))
        } catch (e) {
            storageData = xdr.LedgerEntryData.liquidityPool(xdr.LiquidityPoolEntry.fromXDR(instance, 'base64'))
        }
    }
    return storageData
}

module.exports = {extractInstanceStorage}