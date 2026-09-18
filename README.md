# market-ingest-service

Polls Coinbase spot prices and writes them to InfluxDB.

Two series are maintained:

| Series | Bucket | Resolution | Retention | Written by |
|---|---|---|---|---|
| `spot_price` | `market_data` | every `granularityMinutes` (1 min) | 30 days | the live poller |
| `price_hourly` | `market_history` | 1 point per hour | **forever** | the hourly history job |

`market_data` is the high-resolution working set that the zoomed-in charts read. It expires after
30 days, which is why the second series exists: executed trades live in their own retention-free
bucket and outlive the prices they were made at, so an all-time view of trades needs a price line
that goes back just as far. At one point per hour, three tickers cost ~26k points per year — small
enough to keep indefinitely.

## Hourly history

Each hour (a couple of minutes past, once the hour has closed) the service re-checks a trailing
window — `history.lookbackHours`, 72h by default — and fills any hour missing from `market_history`.
Checking a window rather than just the hour that ended means a restart or a brief outage repairs
itself with no manual step.

Each missing hour is resolved from one of two sources, in order:

1. **A rollup of our own minute ticks** in `market_data` (open/high/low/close/sample count). Same
   underlying data the minute charts show, so the two views agree. Only available inside the
   30-day retention window, and only used when the hour holds at least `history.minRollupCoverage`
   of its expected ticks — a half-empty hour falls through to the candle instead.
2. **Coinbase's public hourly candles** (`api.exchange.coinbase.com`, no API key). The only way to
   reach hours that already expired or predate this service, and the fallback for thin hours.

Points are keyed by `(price_hourly, ticker, hour-start)`, so re-running over an already-populated
range overwrites in place rather than duplicating. Both the scheduled job and the backfill CLI are
safe to run as often as you like. The hour currently in progress is never written.

Fields: `open`, `high`, `low`, `close`, `volume` (candles only), `samples` (rollups only), and
`source` (`rollup` or `candles`, so you can tell where any given hour came from).

The `market_history` bucket is created automatically with no retention if it doesn't exist.

## Backfill

Seeding history older than the retention window is a one-shot CLI:

```bash
node backfill.js --start 2026-01-01          # to now
node backfill.js --start 2026-01-01 --stop 2026-03-01
node backfill.js --tickers BTC-USD,ETH-USD
node backfill.js --dry-run                   # report what it would write, write nothing
node backfill.js --force                     # rewrite hours already present
```

With no `--start` it uses `history.backfillStart` from `config.yml`. Already-populated hours are
skipped, so an interrupted run just picks up where it left off.

## Configuration

`config.yml`, overridable per key by environment variable:

| Key | Env var |
|---|---|
| `influxdb.url` / `.token` / `.org` / `.bucket` | `INFLUXDB_URL` / `INFLUXDB_TOKEN` / `INFLUXDB_ORG` / `INFLUXDB_BUCKET` |
| `service.granularityMinutes` | `M_GRANULARITY` |
| `service.tickers` | `M_TICKERS` (comma-separated) |
| `history.enabled` | `HISTORY_ENABLED` |
| `history.bucket` | `HISTORY_BUCKET` |
| `history.measurement` | `HISTORY_MEASUREMENT` |
| `history.lookbackHours` | `HISTORY_LOOKBACK_HOURS` |
| `history.backfillStart` | `HISTORY_BACKFILL_START` |
| `history.minRollupCoverage` | `HISTORY_MIN_ROLLUP_COVERAGE` |

A different config file path can be given with `CONFIG_PATH`.

## Querying the archive

```flux
from(bucket: "market_history")
  |> range(start: 2026-01-01T00:00:00Z)
  |> filter(fn: (r) => r._measurement == "price_hourly")
  |> filter(fn: (r) => r.ticker == "BTC-USD")
  |> filter(fn: (r) => r._field == "close")
```

## Docker

```bash
# Build
docker build -t market-ingest-service .

# Tag
docker tag market-ingest-service:latest 192.168.1.53:5000/market-ingest-service:latest

# Push
docker push 192.168.1.53:5000/market-ingest-service:latest

# One-off backfill against the same image
docker run --rm market-ingest-service node backfill.js --start 2026-01-01
```
