# @reflector/stellar-connector

> Stellar asset price feed connector for Reflector backend

## Installation

Add package reference to the `dependencies` section of `package.json`

```json
{
  "dependencies": {
    "@reflector/stellar-connector": "github:reflector-network/reflector-stellar-connector#v3.3.0"
  }
}
```

## Usage

Please note that RPC server must
have [`getTransactions`](https://developers.stellar.org/docs/data/rpc/api-reference/methods/getTransactions)
and [`getLatestLedger`](https://developers.stellar.org/docs/data/rpc/api-reference/methods/getLatestLedger)
API endpoints enabled.

Aggregate trades for a given period:
```js
const {createRpcConnection, normalizeTimestamp} = require('@reflector/stellar-connector')

const period = 60
const limit = 7
const from = normalizeTimestamp(new Date().getTime() / 1000, period) - period * limit
console.log('From', from)
aggregateTrades({
    rpcUrl: 'http://...',
    baseAsset: {type: 1, code: 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'},
    assets: [
        {type: 1, code: 'XRF:GCHI6I3X62ND5XUMWINNNKXS2HPYZWKFQBZZYBSMHJ4MIP2XJXSZTXRF'},
        {type: 1, code: 'AQUA:GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA'}
    ],
    from,
    period,
    limit
})
    .then(res => console.log(res))
    .catch(e => console.error(e))
/*
[
  [
    { price: 0n, ts: 1735890540 },
    { price: 3937242822n, ts: 1735890540 }
  ],
  [
    { price: 1346588n, ts: 1735890600 },
    { price: 295468416n, ts: 1735890600 }
  ]
]*/
```

## Tests

```
npm run test
```