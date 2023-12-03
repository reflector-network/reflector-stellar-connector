# @reflector/reflector-db-connector

> StellarCore database connector for Reflector backend

## Installation

Add package reference to the `dependencies` section of `package.json`

```json
{
  "dependencies": {
    "@reflector/reflector-db-connector": "github:reflector-network/reflector-db-connector#v0.5.0"
  }
}
```

## Usage

Initialize CoreDB connection to work with.  
Note: creating multipleDbConnector instances is bad idea, use singleton db connector instances locally to pass them to
other functions.

```js
const db = createDbConnection('postgres://stellar:db_password@127.0.0.1:54321/futurenet')
```

Retrieve current contract state data:

```js
retrieveContractState(db, 'CAQF...')
    .then(res => console.log(res))
/*{
  prices: [200124486333288n, 300121829628006n, 0n],
  admin: 'GCE...',
  lastTimestamp: 0n
 */
```

Aggregate trades for a given period:

```js
aggregateTrades({
    db,
    baseAsset: new Asset('USD', 'GBCC..'),
    assets: [
        new Asset('EUR', 'GC9L...'),
        new Asset('CHF', 'GAA0')
    ],
    decimals: 14,
    from: 1693138200,
    period: 300,
    prevPrices: [200124486333288n, 300121829628006n, 0n]
})
    .then(res => console.log(res))

/*
[200034486332703n, 300041829628294n, 0n]
*/
```

Fetch account signers and thresholds:

```js
retrieveAccountProps(db, 'GCB...')
    .then(res => console.log(res))

/*{
  sequence: 1589182379660938n,
  signers: [
    {"address": "GAO...", "weight": 1},
    {"address": "GBF...", "weight": 1},
    {"address": "GCC...", "weight": 1},
    {"address": "GC6...", "weight": 1},
    {"address": "GDT...", "weight": 1}
  ],      
  thresholds: [0, 3, 3, 3]
}*/
```

## Tests

```
npm run test
```