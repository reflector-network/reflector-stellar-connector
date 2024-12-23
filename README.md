# @reflector/stellar-connector

> Stellar asset price feed connector for Reflector backend

## Installation

Add package reference to the `dependencies` section of `package.json`

```json
{
  "dependencies": {
    "@reflector/reflector-db-connector": "github:reflector-network/reflector-stellar-connector#v3.0.0"
  }
}
```

## Usage

Please note that RPC server must
have [`getTransactions`](https://developers.stellar.org/docs/data/rpc/api-reference/methods/getTransactions)
and [`getLedgerEntries`](https://developers.stellar.org/docs/data/rpc/api-reference/methods/getLedgerEntries)
API endpoints enabled.

Aggregate trades for a given period:
```js
const {createRpcConnection} = require('@reflector/stellar-connector')

aggregateTrades({
    rpcUrl: 'http://localhost:8080',
    baseAsset: {type: 1, code: 'USDC:GA5...'},
    assets: [
        {type: 1, code: 'XRF:GCH...'},
        {type: 1, code: 'AQUA:GBN...'}
    ],
    from: 1734909134,
    period: 60,
    limit: 2
}).then(res => console.log(res))
/*[
    [
        {
            quoteVolume: 5319168566n,
            volume: 10670398723n
        },
        {
            quoteVolume: 0n,
            volume: 0n
        }
    ],
    [
        {
            quoteVolume: 4239198712n,
            volume: 14068368020n
        },        
        {
            quoteVolume: 2016928760n,
            volume: 6032655521n
        }
    ]
]*/
```

## Tests

```
npm run test
```