const os = require('os')
const path = require('path')
const fs = require('fs')
const {Networks, xdr, StrKey, Address} = require('@stellar/stellar-sdk')
const {normalizeTimestamp, getVWAP} = require('../src/utils')
const StellarProvider = require('../src')

/*eslint-disable no-undef */

const collectedLogs = {}

//Save the original method
const originalDebug = console.debug

//Override it
console.debug = function(...args) {
    //Save a copy of the data with a timestamp
    if (args[0].msg === 'Adding volumes') {
        const normalized = {...args[0]}
        normalized.vwap = getVWAP(normalized.baseVolume, normalized.quoteVolume).toString()
        normalized.baseVolume = normalized.baseVolume.toString()
        normalized.quoteVolume = normalized.quoteVolume.toString()
        const pair = `${normalized.baseAsset || normalized.baseToken}-${normalized.asset}`
        const ts = normalized.ts
        if (!collectedLogs[pair]) {
            collectedLogs[pair] = {}
        }
        if (!collectedLogs[pair][ts]) {
            collectedLogs[pair][ts] = []
        }
        collectedLogs[pair][ts].push(normalized)
        delete normalized.msg
        delete normalized.ts
    }

    //Still print it out in the actual console
    originalDebug.apply(console, args)
}

console.debug({msg: 'Initializing asset volumes accumulator'})

//console.info = jest.fn()
//console.warn = jest.fn()
//console.log = jest.fn()

//set STELLAR_EXPERT_TOKEN env var to authorize live API requests, never hardcode the token here
const HEADERS = {Origin: 'https://stellar.expert', Authorization: `Bearer ${process.env.STELLAR_EXPERT_TOKEN || ''}`}
const API_BASE = 'https://api.stellar.expert'

async function fetchTxs(param, id, to, {limit = 100} = {}) {
    const url = `${API_BASE}/explorer/public/tx?${param}%5B%5D=${encodeURIComponent(id)}&order=desc&limit=${limit}&to=${to}`
    return await fetchData(url)
}

async function fetchData(url) {
    const res = await fetch(url, {headers: HEADERS})
    if (!res.ok)
        throw new Error(`HTTP ${res.status} fetching ${url}`)
    return await res.json()
}

//Transactions a contract account participated in (Aqua/Soroban pool C-strkey, or any contract).
const fetchContractTxs = async (contractId, to, opts) => {
    let txs = await fetchTxs('account', contractId, to, opts)
    let next = txs._links.next ? `${API_BASE}${txs._links.next.href}` : null
    while (next) {
        for (const tx of txs._embedded?.records || []) {
            const parsedMeta = xdr.TransactionMeta.fromXdr(tx.meta, 'base64')
            const operations = parsedMeta?.value?.operations
            for (const op of operations) {
                for (const change of op.changes) {
                    if (change.type !== 'ledgerEntryState')
                        continue
                    const targetChange = change.state?.data?.value?.contract?.contractId
                    if (!targetChange)
                        continue
                    const changedContractId = Address.contract(targetChange.value).toString()
                    if (contractId !== changedContractId)
                        continue
                    const instanceUpdated = change.state.data.contractData.toXdr('base64')
                    if (instanceUpdated) {
                        return {xdr: instanceUpdated, lastModifiedLedgerSeq: tx.ledger}
                    }
                }
            }
        }
        txs = next ? await fetchData(next) : null
        next = txs._links.next ? `${API_BASE}${txs._links.next.href}` : null
    }
    console.error(`Instance not found for contract ID: ${contractId}`)
}

//Transactions involving a classic Stellar liquidity pool (64-hex hash or L-strkey).
const fetchPoolTxs = async (poolId, to, opts) => {
    let txs = await fetchTxs('pool', poolId, to, opts)
    let next = txs._links.next ? `${API_BASE}${txs._links.next.href}` : null
    while (next) {
        for (const tx of txs._embedded?.records || []) {
            const parsedMeta = xdr.TransactionMeta.fromXdr(tx.meta, 'base64')
            const operations = parsedMeta?.value?.operations
            for (const op of operations) {
                for (const change of op.changes) {
                    if (change.type !== 'ledgerEntryState')
                        continue
                    const targetChange = change.state?.data?.value?.liquidityPoolId
                    if (!targetChange)
                        continue
                    if (poolId !== targetChange.toString('hex'))
                        continue
                    const instanceUpdated = change.state.data.liquidityPool.toXdr('base64')
                    if (instanceUpdated) {
                        return {xdr: instanceUpdated, lastModifiedLedgerSeq: tx.ledger}
                    }
                }
            }
        }
        txs = next ? await fetchData(next) : null
        next = txs._links.next ? `${API_BASE}${txs._links.next.href}` : null
    }
    console.error(`Instance not found for pool ID: ${poolId}`)
}

const fetchLedgerByTimestamp = async (timestamp) => {
    const url = `${API_BASE}/explorer/public/ledger/sequence-from-timestamp?timestamp=${timestamp}`
    const res = await fetchData(url, {headers: HEADERS})
    return res.sequence
}

describe('get price test', () => {
    let cacheDir
    beforeEach(() => {
        cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-provider-test-'))
    })

    afterEach(() => {
        fs.rmSync(cacheDir, {recursive: true, force: true})
    })

    //test('getPriceData', async () => {

    //const provider = new StellarProvider()
    //await provider.init({rpcUrls: ['http://localhost:8003'], network: Networks.PUBLIC, cacheDir})
    //const usdcBase = 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
    //const assets = ['BTCLN:GDPKQ2TSNJOFSEE7XSUXPWRP27H6GFGLWD7JCHNEYYWQVGFA543EVBVT', 'AQUA:GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA', 'yUSDC:GDGTVWSM4MGS4T7Z6W4RPWOCHE2I6RDFCIFZGS3DOA63LWQTRNZNTTFF', 'FIDR:GBZQNUAGO4DZFWOHJ3PVXZKZ2LTSOVAMCTVM46OEMWNWTED4DFS3NAYH', 'SSLX:GBHFGY3ZNEJWLNO4LBUKLYOCEK4V7ENEBJGPRHHX7JU47GWHBREH37UR', 'ARST:GCSAZVWXZKWS4XS223M5F54H2B6XPIIXZZGP7KEAIU6YSL5HDRGCI3DG', 'EURC:GAQRF3UGHBT6JYQZ7YSUYCIYWAF4T2SAA5237Q5LIQYJOHHFAWDXZ7NM', 'XLM', 'XRP:GBXRPL45NPHCVMFFAYZVUVFFVKSIZ362ZXFP7I2ETNQ3QKZMFLPRDTD5', 'EURC:GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2', 'XRF:GCHI6I3X62ND5XUMWINNNKXS2HPYZWKFQBZZYBSMHJ4MIP2XJXSZTXRF', 'USDGLO:GBBS25EGYQPGEZCGCFBKG4OAGFXU6DSOQBGTHELLJT3HZXZJ34HWS6XV', 'CETES:GCRYUGD5NVARGXT56XEZI5CIFCQETYHAPQQTHO2O3IQZTHDH4LATMYWC', 'USTRY:GCRYUGD5NVARGXT56XEZI5CIFCQETYHAPQQTHO2O3IQZTHDH4LATMYWC', 'KALE:GBDVX4VELCDSQ54KQJYTNHXAHFLBCA77ZY2USQBM4CSHTTV7DME7KALE', 'TESOURO:GCRYUGD5NVARGXT56XEZI5CIFCQETYHAPQQTHO2O3IQZTHDH4LATMYWC', 'SBC:GCQCNWT22JDLENQAVIE6DRJGHWAQ6EX2H5ABGPV55EJUPPZM5UA7KHZR', 'UAH:GCJI3CP2NL6NWSCHM36XBQYCBHOTVVZWEXZALWON34KAYUGF6GEVNRTS', 'GYEN:GDF6VOEGRWLOZ64PQQGKD2IYWA22RLT37GJKS2EJXZHT2VLAGWLC5TOB', 'ZUSD:GDF6VOEGRWLOZ64PQQGKD2IYWA22RLT37GJKS2EJXZHT2VLAGWLC5TOB', 'AUDD:GDC7X2MXTYSAKUUGAIQ7J7RPEIM7GXSAIWFYWWH4GLNFECQVJJLB2EEU', 'EURS:GC5FGCDEOGOGSNWCCNKS3OMEVDHTE3Q5A5FEQWQKV3AXA7N6KDQ2CUZJ', 'VCHF:GDXLSLCOPPHTWOQXLLKSVN4VN3G67WD2ENU7UMVAROEYVJLSPSEWXIZN', 'VEUR:GDXLSLCOPPHTWOQXLLKSVN4VN3G67WD2ENU7UMVAROEYVJLSPSEWXIZN', 'abUSDC:GALLBRBQHAPW5FOVXXHYWR6J4ZDAQ35BMSNADYGBW25VOUHUYRZM4XIL', 'aeUSDC:GALLBRBQHAPW5FOVXXHYWR6J4ZDAQ35BMSNADYGBW25VOUHUYRZM4XIL', 'apUSDC:GALLBRBQHAPW5FOVXXHYWR6J4ZDAQ35BMSNADYGBW25VOUHUYRZM4XIL', 'apUSDT:GALLBRBQHAPW5FOVXXHYWR6J4ZDAQ35BMSNADYGBW25VOUHUYRZM4XIL', 'asUSDC:GALLBRBQHAPW5FOVXXHYWR6J4ZDAQ35BMSNADYGBW25VOUHUYRZM4XIL', 'abBNB:GALLBRBQHAPW5FOVXXHYWR6J4ZDAQ35BMSNADYGBW25VOUHUYRZM4XIL', 'ARS:GCYE7C77EB5AWAA25R5XMWNI2EDOKTTFTTPZKM2SR5DI4B4WFD52DARS', 'PEN:GA4TDPNUCZPTOHB3TKUYMDCRVATXKEADH7ZEYEBWJKQKE2UBFCYNBPEN', 'ARSX:GA6NRRSBXCKZSCG56ODM5B6S5GUBLUEQSII4GUVQ7DFPEDJUGES7XVF7', 'KES:GA2MSSZKJOU6RNL3EJKH3S5TB5CDYTFQFWRYFGUJVIN5I6AOIRTLUHTO', 'RWF:GA2MSSZKJOU6RNL3EJKH3S5TB5CDYTFQFWRYFGUJVIN5I6AOIRTLUHTO', 'acCELO:GALLBRBQHAPW5FOVXXHYWR6J4ZDAQ35BMSNADYGBW25VOUHUYRZM4XIL', 'aeETH:GALLBRBQHAPW5FOVXXHYWR6J4ZDAQ35BMSNADYGBW25VOUHUYRZM4XIL', 'apMATIC:GALLBRBQHAPW5FOVXXHYWR6J4ZDAQ35BMSNADYGBW25VOUHUYRZM4XIL', 'asSOL:GALLBRBQHAPW5FOVXXHYWR6J4ZDAQ35BMSNADYGBW25VOUHUYRZM4XIL', 'TZS:GA2MSSZKJOU6RNL3EJKH3S5TB5CDYTFQFWRYFGUJVIN5I6AOIRTLUHTO', 'CLPX:GDYSPBVZHPQTYMGSYNOHRZQNLB3ZWFVQ2F7EP7YBOLRGD42XIC3QUX5G', 'IDRT:GDPKQ2TSNJOFSEE7XSUXPWRP27H6GFGLWD7JCHNEYYWQVGFA543EVBVT', 'KRW:GDPKQ2TSNJOFSEE7XSUXPWRP27H6GFGLWD7JCHNEYYWQVGFA543EVBVT', 'TRYB:GDPKQ2TSNJOFSEE7XSUXPWRP27H6GFGLWD7JCHNEYYWQVGFA543EVBVT', 'XCHF:GDPKQ2TSNJOFSEE7XSUXPWRP27H6GFGLWD7JCHNEYYWQVGFA543EVBVT', 'XSGD:GDPKQ2TSNJOFSEE7XSUXPWRP27H6GFGLWD7JCHNEYYWQVGFA543EVBVT', 'MBRL:GDLS4RCNECY46KKA4OGU2MMJILUK3I372CUFISWM4HKCV7265RY2NJ4Z', 'BRLT:GCHQ3F2BF5P74DMDNOOGHT5DUCKC773AW5DTOFINC26W4KGYFPYDPRSO', 'XAF:GAP5LETOV6YIE62YAM56STDANPRDO7ZFDBGSNHJQIYGGKSMOZAHOOS2S', 'CBIJBDNZNF4X35BJ4FFZWCDBSCKOP5NB4PLG4SNENRMLAPYG4P5FM6VN']
    //const crossAssets = ['XLM', 'yUSDC:GDGTVWSM4MGS4T7Z6W4RPWOCHE2I6RDFCIFZGS3DOA63LWQTRNZNTTFF', 'sUSD:GCHW7CWI7GMIYQYFXMFJNJX5645XGWIINIAEQK3SABQO6CAYL5T7JYIH']

    //const tf = 60
    ////ts is current timestamp minus timeframe to get completed timestamp
    //let ts = normalizeTimestamp(Date.now() / 1000, tf) - tf
    //let count = 15 //first load is 15 to emulate node start
    ////eslint-disable-next-line no-constant-condition
    //while (true) {
    //try {
    //const result = await provider.getPriceData({
    //baseAsset: usdcBase,
    //assets,
    //from: ts,
    //period: tf,
    //count,
    //crossAssets
    //})
    //console.table(assets.map((asset, i) => {
    //const entry = result[0][i][0]
    //return {asset, volume: entry.volume, quoteVolume: entry.quoteVolume, price}
    //}))
    //count = 1
    //} catch (e) {
    //console.error(e)
    //} finally {
    //ts += tf
    //await new Promise(resolve => setTimeout(resolve, (ts + tf) * 1000 - Date.now() + 15000))
    //}
    //}
    //}, 30000000)


    test('getPriceData', async () => {
        const targetTimestamp = 1780009500//1780009200//
        const count = 5
        const tf = 60
        const fromTs = targetTimestamp - (2 + count) * tf //2 is warm up + minute offset
        //ts is current timestamp minus timeframe to get completed timestamp
        let from = fromTs

        const fromLedger = (await fetchLedgerByTimestamp(from)) - 5
        const toLedger = (await fetchLedgerByTimestamp(targetTimestamp)) + 5

        console.log({fromTs, targetTimestamp, tf, count, fromLedger, toLedger})

        const provider = new StellarProvider()
        await provider.init({rpcUrls: ['http://localhost:8003'], network: Networks.PUBLIC, cacheDir})
        const usdcBase = 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
        const assets = ['yETH:GDYQNEF2UWTK4L6HITMT53MZ6F5QWO3Q4UVE6SCGC4OMEQIZQQDERQFD']
        const crossAssets = ['XLM']

        provider.cache.dispose()
        let returned = false
        provider.connector.generateLedgerRanges = () => {
            if (!returned) {
                returned = true
                return Promise.resolve([{from: fromLedger, to: toLedger}])
            }
            return Promise.resolve([])
        }
        //eslint-disable-next-line no-constant-condition
        const totalRes = []
        while (from < targetTimestamp) {
            const pools = new Map()
            for (const poolContract of provider.cache.poolContracts || []) {
                const [poolAddress, poolProvider] = poolContract
                let instanceData = null
                if (poolProvider.constructor.name === 'AquaPoolProvider') {
                    instanceData = await fetchContractTxs(poolAddress, from + tf)
                } else {
                    instanceData = await fetchPoolTxs(poolAddress, from + tf)
                }
                pools.set(poolAddress, instanceData)
            }
            //the state at from + tf closes the period that starts at from
            provider.cache.pendingPoolData.set(from, {slot: from, boundary: from + tf, servedLedger: null, poolData: pools})
            try {
                const result = await provider.getPriceData({
                    baseAsset: usdcBase,
                    assets,
                    from,
                    period: tf,
                    count: 1,
                    crossAssets
                })
                //console.table(assets.map((asset, i) => {
                //const entry = result[0][i][0]
                //return {asset, volume: entry.volume, quoteVolume: entry.quoteVolume}
                //}))
                const USDxRes = result[0][0][0]
                totalRes.push({...USDxRes, asset: assets[0], ts: from + tf, dt: new Date((from + tf) * 1000).toISOString()})
            } catch (e) {
                console.error(e)
            } finally {
                from += tf
                await new Promise(resolve => setTimeout(resolve, (from + tf) * 1000 - Date.now() + 15000))
            }
        }
        finalRes = totalRes.filter(r => r.ts <= targetTimestamp && r.ts > targetTimestamp - count * tf)
        console.info('Total Results:')
        console.table(totalRes)
        const totalVolume = totalRes.reduce((sum, r) => [sum[0] + r.volume, sum[1] + r.quoteVolume], [0n, 0n])
        console.info('Total Volumes:', totalVolume)

        const min = new Map(); const max = new Map()
        const minHashes = new Map(); const maxHashes = new Map()
        for (let i = 0; i < collectedLogs.length; i++) {
            const p = BigInt(collectedLogs[i].vwap)
            const pair = collectedLogs[i].pair
            if (!min.get(pair) || min.get(pair) > p) {
                min.set(pair, p)
                minHashes.set(pair, collectedLogs[i].txHash)
            }
            if (!max.get(pair) || max.get(pair) < p) {
                max.set(pair, p)
                maxHashes.set(pair, collectedLogs[i].txHash)
            }
        }

        for (const [_, minHash] of minHashes.entries()) {
            collectedLogs.find(l => l.txHash === minHash).min = true
        }

        for (const [_, maxHash] of maxHashes.entries()) {
            collectedLogs.find(l => l.txHash === maxHash).max = true
        }

        console.table(collectedLogs)
        fs.writeFileSync('collected-logs.json', JSON.stringify(collectedLogs))

        console.info('Final Results:')
        console.table(finalRes)
        const finalVolume = finalRes.reduce((sum, r) => [sum[0] + r.volume, sum[1] + r.quoteVolume], [0n, 0n])
        console.info('Final Volumes:', finalVolume)
        console.info('VWAP:', getVWAP(finalVolume[0], finalVolume[1]))
    }, 30000000)
})