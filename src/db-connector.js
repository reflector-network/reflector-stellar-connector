const {Pool} = require('pg')
const Cursor = require('pg-cursor')

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
}

module.exports = DbConnector