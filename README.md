# @reflector/reflector-db-connector

> StellarCore database connector for Reflector backend

## Installation

Add package reference to the `dependencies` section of `package.json`

```json
{
  "dependencies": {
    "@reflector/reflector-db-connector": "github:reflector-network/reflector-db-connector#v2.0.0"
  }
}
```

## Usage

Initialize CoreDB connection to work with.

```js
const db = createDbConnection('postgres://stellar:db_password@127.0.0.1:54321/futurenet')
```  

> Note: creating multiple DbConnector instances is bad idea, use singleton db connector instances locally to pass them
to other functions.

Aggregate trades for a given period:

```js
aggregateTrades({
    db,
    baseAsset: new Asset('USD', 'GBCC..'),
    assets: [
        new Asset('EUR', 'GC9L...'),
        new Asset('CHF', 'GAA0...')
    ],
    from: 1693138200,
    period: 300,
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