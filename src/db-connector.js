const {Pool} = require('pg')
const Cursor = require('pg-cursor')
const contractStateKeys = require('./contract-state-keys')

const MAX_STATE_ENTRIES_SEARCH = 200

class DbConnector {
    /**
     * Create Core DB connector instance
     * @param {String|{}} connectionParams
     */
    constructor(connectionParams) {
        this.pool = new Pool(connectionParams)
    }
    /**
     * @type {Pool}
     * @private
     */
    pool

    /**
     * @param {Number} from - Range lower bound timestamp (inclusive)
     * @param {Number} to - Range upper bound timestamp (inclusive)
     * @param {Function} processResultCallback - Record processing callback
     */
    async fetchProcessTxResults(from, to, processResultCallback) {
        //prepare cursor and query for tx results
        const query = 'select txresult from ledgerheaders l, txhistory t where closetime between $1 and $2 and l.ledgerseq=t.ledgerseq order by closetime'
        const client = await this.pool.connect()
        const cursor = client.query(new Cursor(query, [from, to]))
        //read and process in batches
        while (true) {
            const records = await cursor.read(1000)
            if (!records.length)
                break
            for (const record of records) {
                //call result processor callback
                processResultCallback(record.txresult)
            }
        }
        //release connections
        await cursor.close()
        client.release()
    }

    /**
     * @param {String} contractId - ScAddress-encrypted contract id
     * @return {Promise<ContractStateRawData>}
     */
    async fetchContractState(contractId) {
        const priceQuery = 'select key, ledgerentry, lastmodified from contractdata where contractid=$1 order by lastmodified desc limit ' + MAX_STATE_ENTRIES_SEARCH
        const entriesRes = await this.pool.query(priceQuery, [contractId])
        const prices = []
        let lastModified = 0
        for (const record of entriesRes.rows) {
            if (!record.key.startsWith(contractStateKeys.valuePrefix))
                continue
            if (lastModified !== record.lastmodified) {
                //if timestamp changed, it means that the last prices update batch has been processed in full
                if (lastModified)
                    break
                //update current last modified timestamp
                lastModified = record.lastmodified
            }
            prices.push(record.ledgerentry)
        }
        let contractEntry = null
        if (entriesRes.rows.length !== 0) //if there are no entries, it means that the contract is uninitialized. No need to fetch state entries
            contractEntry = await this.fetchContractStateEntries(contractId)
        //assemble response
        return {
            prices,
            contractEntry
        }
    }

    /**
     * @param {String} contractId - ScAddress-encrypted contract id
     * @return {Promise<String>}
     * @private
     */
    async fetchContractStateEntries(contractId) {
        const query = 'select ledgerentry from contractdata where contractid=$1 and type=1 limit 1'
        const res = await this.pool.query(query, [contractId])
        if (!res.rows?.length)
            return null
        const entry = res.rows[0]
        return entry.ledgerentry
    }

    /**
     * @param {String} accountAddress
     * @return {Promise<{sequence: BigInt, thresholds: Number[], signers: {address: String, weight: Number}[]}>}
     */
    async fetchAccountProps(accountAddress) {
        const query = 'select seqnum, signers, thresholds from accounts where accountid=$1'
        const res = await this.pool.query(query, [accountAddress])
        const acc = res.rows[0]
        return {
            sequence: BigInt(acc.seqnum),
            thresholds: [...Buffer.from(acc.thresholds, 'base64')],
            signers: acc.signers
        }
    }
}

/**
 * @typedef {{}} ContractStateRawData
 * @property {String[]} prices
 * @property {String} contractEntry
 */

module.exports = DbConnector