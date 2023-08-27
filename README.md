# @reflector/reflector-db-connector

> StellarCore database connector for Reflector backend

## Installation

Add package reference to the `dependencies` section of `package.json`

```json
{
  ...
  "dependencies": {
    "@reflector/reflector-db-connector": "github:reflector-network/reflector-db-connector#v0.4.2",
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
    period: 300,
    protocolVersion: 1
})
    .then(res => console.log(res))
    .catch(e => console.error(e))
```