# @reflector/reflector-db-connector

> StellarCore database connector for Reflector backend

## Installation

Add package reference to the `dependencies` section of `package.json`

```json
{
  ...
  "dependencies": {
    "@reflector/reflector-db-connector": "github:reflector-network/reflector-db-connector#v0.5.0",
    ...
  }
}
```

## Usage

Initialize PostgreSQL connection (only once)
```js
init({
    user: 'stellar',
    database: 'futurenet',
    password: 'rtXX76s@DWjff#',
    host: '127.0.0.1',
    port: 54321
})
```

Aggregate trades for a given period
```js
aggregateTrades({
    contract: 'CAQF...',
    baseAsset: new Asset('USD', 'GBCC..'),
    assets: [
        new Asset('EUR', 'GC9L...'),
        new Asset('CHF', 'GAA0')
    ],
    decimals: 14,
    from: 1693138200,
    period: 300
})
    .then(res => console.log(res))
    .catch(e => console.error(e))

/*{
  prices: [200034486332703n, 300041829628294n, 0n],
  admin: {
    address: 'GBE...',
    sequence: 1589182379660938n,
    signers: [
      {"address": "GAO...", "weight": 1},
      {"address": "GBF...", "weight": 1},
      {"address": "GCC...", "weight": 1},
      {"address": "GC6...", "weight": 1},
      {"address": "GDT...", "weight": 1}
    ],      
    thresholds: [0, 3, 3, 3]
  }
}*/
```

## Tests

```
npm run test
```