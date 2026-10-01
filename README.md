# @reflector/stellar-connector

> Stellar asset price feed connector for Reflector backend

Given a base asset, a list of tracked assets and a run of one-minute periods, this package returns a `{volume, quoteVolume}` pair per (period, asset) denominated in the base asset. Two observations feed those pairs: classic SDEX trades decoded from transaction results, and AMM pool reserves (Aqua constant-product, stableswap and concentrated; SushiSwap V3; classic Stellar liquidity pools) counted as volume at the pool's implied price.

Every node in the cluster runs this connector independently and the node keeps only the values a **majority of nodes report byte-identically**, so everything here is written to be deterministic across nodes.

## Installation

Node.js >= 22.12. Peer dependency: `@stellar/stellar-sdk >= 17`.

```json
{
  "dependencies": {
    "@reflector/stellar-connector": "github:reflector-network/reflector-stellar-connector#v4.3.0"
  }
}
```

## RPC requirements

The Stellar RPC endpoints passed to `init` must expose `getTransactions`, `getTransaction`, `getLedgerEntries` and `simulateTransaction`. Ledger info is derived from a `getTransaction` on the all-zero hash; `getLatestLedger` is not used. Without `getLedgerEntries` there is no pool data at all.

Every request has a 15 s deadline and is tried on each URL in turn, up to three rounds. It starts at the URL that answered last; that preference expires ten minutes after it was set, so the configured order, primary first, is tried again. A first URL that hangs therefore costs one deadline, not one per request.

## Usage

```js
const StellarProvider = require('@reflector/stellar-connector')

const provider = new StellarProvider()
await provider.init({
    rpcUrls: ['https://rpc.example.org'],
    network: 'Public Global Stellar Network ; September 2015',
    cacheDir: '/var/reflector/cache'
})

const data = await provider.getPriceData({
    baseAsset: 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    assets: ['AQUA:GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA', 'XLM'],
    from: 1780009200, //seconds, start of the first period
    period: 60,       //seconds; must equal the cache period, which is 60
    count: 5,         //number of periods
    simSource: 'GDLMOS3LF2CRRFCWDJ6TX3YIEYBBTZGAF3BSSEXOXFZWYHSCOHT6DRFX',
    crossAssets: ['XLM']
})
//data[periodIndex][assetIndex] === [{volume: 123n, quoteVolume: 456n, ts: 1780009200}]
//price = volume * 10n ** 14n / quoteVolume

await provider.dispose() //stops the pool worker and waits for an in-flight tick
```

`volume` is always the base-asset side and `quoteVolume` the tracked-asset side, both `BigInt` at 14 decimals. `dispose()` returns a promise; `init()` disposes a cache built by an earlier `init()`.

## Pool providers

`getPriceData({options: {sources}})` chooses the pool providers and their settings. reflector-node passes a data source's `providers` block here, so for a Stellar source it is set in `app.config.json`:

```json
"providers": {
  "AQUA": {"aquaListUrl": "https://amm-api.aqua.network/pools/?size=500"},
  "STELLAR_LIQUIDITY": {},
  "SUSHISWAP": {"factoryContract": "CD3KRKGDRVWPXVB3VXLUMQKMX6XZ6Q2H334IVZD4XXNAMKSRVQL5GLYF"}
}
```

- Without `sources`, all three providers run with their defaults. An object runs only the providers it names; `{}` runs none, so every asset is priced from DEX trades alone. An array of names runs those providers with default settings. An unknown name is warned about and ignored.
- `aquaListUrl` is the full URL of the first page of the Aqua pool list and is requested exactly as given (default `https://amm-api.aqua.network/pools/?size=500`, `https` only). The list is refreshed hourly and kept in `<cacheDir>/aqua-pools.json` with the URL it came from: when a refresh fails the last list from the same URL is used, a list from another URL never is, and changing the URL loads the new list at once.
- `factoryContract` is the SushiSwap V3 factory contract id (default `CD3KRKGDRVWPXVB3VXLUMQKMX6XZ6Q2H334IVZD4XXNAMKSRVQL5GLYF`).
- An unset setting takes its default. An invalid one fails that provider instead of falling back to the default.
- **Every node of a cluster must use the same `providers` block.** A node that differs reports different volumes and loses its vote for those minutes. To stop using a provider that broke — for example SushiSwap after its factory is removed — change the block on every node.

## How a period is priced

- **Pool snapshot.** A period's pool reserves are the state at the last ledger that closed before the period's end; a ledger closing exactly at a boundary belongs to the next period, as its trades do. A worker starts 5 s before each minute boundary T and every 500 ms reads the latest ledger and its close time; on each new ledger it reads every tracked pool with `getLedgerEntries` and keeps the ledger the answer was served at. With more than 200 pools every request must be served at the same ledger, or the read is discarded. A read at ledger N is inside the period once a ledger at or after N is seen closing before T, and it is the period's last ledger when the first ledger seen closing at or after T is N + 1. Anything else leaves the period without a snapshot: no proven read, a ledger of the period that was never read, or no ledger closing at or after T within 10 s. An entry's `lastModifiedLedgerSeq` plays no part: a pool untouched for days is read with its current reserves, which are its state at the served ledger. The snapshot is stored with the period T closes, beside that period's DEX trades, and logged (`Pool reserves snapshot`) with the served ledger and each pool's reserves. Until the first `getPriceData` call the tracked pools are unknown and no snapshot is taken, and `getPriceData` waits for a running tick before it reads. Polling the RPC every 500 ms from 5 s before each boundary until a ledger past it appears costs about 20 extra light requests per minute per network, which matters on rate-limited RPC providers.
- **Liquidity floor.** A pool must hold at least `minBaseVolume` whole units (default `100`) of **base-side** reserve to contribute anything — not dollars, not TVL, and not the quote side. A pool below the floor is dropped whole, so the reserves it still holds leave the period with it. It stops a dust pool pricing an asset. A candidate whose implied price or quote reserve is not positive is rejected separately as malformed — that is a check on unusable input, not a guard.

  Every pool above the floor is summed into a single volume-weighted pair (`volume = Σ base`, `quoteVolume = Σ quote`), so the published price `Σ base / Σ quote` is the base-weighted harmonic mean of the pools' implied prices. Nothing is outvoted and nothing is rescaled — but **passing the floor is not the same as counting.** `AssetVolumesAccumulator` drops a pool with *either* side below `MIN_VOLUME` (`1e9` raw, `1e-5` whole units), so a pool the floor admits can contribute exactly nothing: measured, a 200-unit pool with `999999999` raw on the quote side is accepted by the floor and adds nothing, while at `1000000000` raw it adds both sides.

  `minBaseVolume` can be overridden per call through `getPriceData({options: {poolGuards: {minBaseVolume: n}}})`, but it is part of the consensus contract: a node running a different floor reports different numbers and is dropped from the cluster majority. Change it everywhere or nowhere. Unknown keys are named in a single warning and ignored.
- **DEX trades** count only for a period that has its pool snapshot. Without one the period reports no DEX volume and logs `No pool snapshot for period - DEX trades not counted`. A snapshot holding no pools — an asset with no pools — still counts its trades. Within such a period an asset's trades count only if pool discovery tried its pools for it: some enabled provider found pools for the asset, or every enabled provider answered. An asset added since the last `getPriceData` call, or one whose only provider failed, reports no DEX volume for that period.
- **Stableswap amplification** is interpolated from the period timestamp, never from the node's clock.
- **Aqua pool list** is refreshed hourly from `aquaListUrl` (see "Pool providers") with a 10 s deadline, a 5 MiB body cap, no redirects and host-pinned pagination, and persisted to `<cacheDir>/aqua-pools.json`. A list that stops before its end — a next page on another host, more than 20 pages or 5000 pools — is a failed refresh, not a shorter list. The API's declared token pair must match the pair in the pool's own contract storage, and token decimals come from the token contracts (`decimals()`) whenever they are known; a token with no metadata at all falls back to the value the pool declares, or to `7` when the pool declares none either. (Calling `getPriceData` without `simSource` does *not* reach it — `updateTokenMeta`'s `accountId` is a default parameter, so an omitted argument still uses the default account. Only an explicit falsy value returns early.) A `decimals()` call that *fails* does not reach the fallback either: it records `failedAt`, `resolveDigits` returns `null`, and the pool is dropped. Pubnet only.

## Tests

```
npm test          # offline suite; no network, no local RPC
npm run test:live # live harnesses: needs a Stellar RPC on http://localhost:8003, the Aqua API and api.stellar.expert
```

The `get-price` live suite writes diagnostics to the OS temp directory (override with `STELLAR_CONNECTOR_LOG_FILE`).

