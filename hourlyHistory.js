/**
 * @fileoverview Long-horizon hourly price history.
 *
 * The minute-resolution bucket (market_data) is deliberately ephemeral - it carries a 30-day
 * retention policy, which is plenty for the zoomed-in charts but means an "all time" view of
 * executed trades has no price line to plot against beyond the last month. Trades themselves live
 * in their own retention-free bucket, so they outlive the prices they were made at.
 *
 * This module maintains a second, much smaller series - one point per hour, per ticker, in a bucket
 * with no retention. A year of three tickers is ~26k points, so keeping it forever costs nothing.
 *
 * Two sources fill it, in preference order per missing hour:
 *   1. A rollup of our own minute ticks in market_data. Same data the zoomed-in chart shows, so the
 *      two views agree. Only possible inside the retention window, and only trusted when enough
 *      samples landed in the hour (see HISTORY_MIN_ROLLUP_COVERAGE).
 *   2. Hourly OHLC candles from Coinbase's public Exchange API. The only way to reach hours that
 *      expired (or predate this service entirely), and the fallback whenever a rollup is too thin.
 *
 * Every point is keyed by (measurement, ticker, hour-start), so re-running over a range that is
 * already populated overwrites rather than duplicates. That makes both the scheduled job and the
 * backfill CLI safe to re-run at any time.
 */

const axios = require('axios');
const { InfluxDB, Point } = require('@influxdata/influxdb-client');
const { fetchHourlyCandles } = require('./coinbaseCandles');
const {
   INFLUXDB_URL,
   INFLUXDB_TOKEN,
   INFLUXDB_ORG,
   INFLUXDB_BUCKET,
   M_GRANULARITY,
   HISTORY_BUCKET,
   HISTORY_MEASUREMENT,
   HISTORY_MIN_ROLLUP_COVERAGE,
} = require('./config');

const HOUR_MS = 3600 * 1000;
// Work the range in slices so a multi-month backfill reports progress and never holds a whole
// year of points in memory at once.
const CHUNK_HOURS = 24 * 30;
const PRICE_MEASUREMENT = 'spot_price';

let influxDB;
let queryApi;
let writeApi;

function log(message) {
   console.log(`[${new Date().toISOString()}] ${message}`);
}

/** Truncates an epoch-ms timestamp down to the start of its UTC hour. */
function floorHour(ms) {
   return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

/** Lazily builds the InfluxDB client/APIs, shared by the scheduled job and the backfill CLI. */
function getApis() {
   if (!influxDB) {
      influxDB = new InfluxDB({ url: INFLUXDB_URL, token: INFLUXDB_TOKEN });
      queryApi = influxDB.getQueryApi(INFLUXDB_ORG);
      // Second precision: every timestamp we write is an exact hour boundary.
      writeApi = influxDB.getWriteApi(INFLUXDB_ORG, HISTORY_BUCKET, 's');
   }
   return { queryApi, writeApi };
}

/** Runs a Flux query and returns an array of row objects. */
async function query(flux) {
   const { queryApi } = getApis();
   const rows = [];
   for await (const { values, tableMeta } of queryApi.iterateRows(flux)) {
      rows.push(tableMeta.toObject(values));
   }
   return rows;
}

/**
 * Makes sure the history bucket exists with no retention (infinite). Creating it here means a
 * fresh deployment is self-contained rather than depending on someone having clicked through the
 * InfluxDB UI first.
 * @returns {Promise<boolean>} True if the bucket exists (or was created) and is usable.
 */
async function ensureHistoryBucket() {
   const auth = { headers: { Authorization: `Token ${INFLUXDB_TOKEN}` } };

   try {
      const existing = await axios.get(`${INFLUXDB_URL}/api/v2/buckets`, {
         ...auth,
         params: { org: INFLUXDB_ORG, name: HISTORY_BUCKET },
         timeout: 15000,
      });
      const bucket = existing.data?.buckets?.find(b => b.name === HISTORY_BUCKET);
      if (bucket) {
         const everySeconds = bucket.retentionRules?.[0]?.everySeconds ?? 0;
         if (everySeconds !== 0) {
            console.warn(`[${new Date().toISOString()}] WARNING: bucket "${HISTORY_BUCKET}" has a ${everySeconds}s retention policy. History older than that will be deleted by InfluxDB. Set it to "never" to keep the full archive.`);
         }
         return true;
      }
   } catch (error) {
      // A 404 here just means "no such bucket"; anything else is a real problem worth surfacing.
      if (error.response?.status !== 404) {
         console.error(`[${new Date().toISOString()}] Could not list InfluxDB buckets: ${error.response?.status || ''} ${error.message}`);
         return false;
      }
   }

   log(`Bucket "${HISTORY_BUCKET}" not found; creating it with infinite retention.`);
   try {
      const orgs = await axios.get(`${INFLUXDB_URL}/api/v2/orgs`, {
         ...auth,
         params: { org: INFLUXDB_ORG },
         timeout: 15000,
      });
      const orgID = orgs.data?.orgs?.[0]?.id;
      if (!orgID) throw new Error(`Organization "${INFLUXDB_ORG}" not found`);

      await axios.post(`${INFLUXDB_URL}/api/v2/buckets`, {
         orgID,
         name: HISTORY_BUCKET,
         description: 'Hourly price history, retained forever so all-time charts outlive market_data retention.',
         retentionRules: [], // No rules = keep forever.
      }, { ...auth, timeout: 15000 });

      log(`Created bucket "${HISTORY_BUCKET}".`);
      return true;
   } catch (error) {
      console.error(`[${new Date().toISOString()}] Failed to create bucket "${HISTORY_BUCKET}": ${error.response?.status || ''} ${error.response?.data?.message || error.message}`);
      console.error(`[${new Date().toISOString()}] Create it manually, then re-run:  influx bucket create --name ${HISTORY_BUCKET} --org ${INFLUXDB_ORG} --retention 0`);
      return false;
   }
}

/**
 * Hours already present in the history bucket for a ticker.
 * @returns {Promise<Set<number>>} Hour-start epoch ms values.
 */
async function getExistingHours(ticker, startMs, stopMs) {
   const flux = `from(bucket: "${HISTORY_BUCKET}")
  |> range(start: ${new Date(startMs).toISOString()}, stop: ${new Date(stopMs).toISOString()})
  |> filter(fn: (r) => r._measurement == "${HISTORY_MEASUREMENT}")
  |> filter(fn: (r) => r.ticker == "${ticker}")
  |> filter(fn: (r) => r._field == "close")
  |> keep(columns: ["_time"])`;

   const hours = new Set();
   try {
      for (const row of await query(flux)) {
         hours.add(new Date(row._time).getTime());
      }
   } catch (error) {
      // An empty/brand-new bucket can query fine, so a failure here is genuinely unexpected -
      // treat the range as unpopulated and let the (idempotent) write pass repair it.
      console.warn(`[${new Date().toISOString()}] Could not read existing history for ${ticker}: ${error.message}`);
   }
   return hours;
}

/**
 * Aggregates our own minute-resolution ticks in market_data into hourly OHLC.
 * Only returns hours that actually contain ticks; `samples` lets the caller reject thin hours.
 * @returns {Promise<Map<number, object>>} Hour-start epoch ms -> { open, high, low, close, samples }.
 */
async function rollupFromMarketData(ticker, startMs, stopMs) {
   const start = new Date(startMs).toISOString();
   const stop = new Date(stopMs).toISOString();
   // timeSrc: "_start" stamps each aggregate at the beginning of its window, so the point lands
   // exactly on the hour boundary it describes (the default, "_stop", would label 09:00-10:00 as 10:00).
   const flux = `base = from(bucket: "${INFLUXDB_BUCKET}")
  |> range(start: ${start}, stop: ${stop})
  |> filter(fn: (r) => r._measurement == "${PRICE_MEASUREMENT}")
  |> filter(fn: (r) => r.ticker == "${ticker}")
  |> filter(fn: (r) => r._field == "price")
  |> group(columns: ["_measurement"])

o = base |> aggregateWindow(every: 1h, fn: first, timeSrc: "_start", createEmpty: false) |> set(key: "agg", value: "open")
h = base |> aggregateWindow(every: 1h, fn: max,   timeSrc: "_start", createEmpty: false) |> set(key: "agg", value: "high")
l = base |> aggregateWindow(every: 1h, fn: min,   timeSrc: "_start", createEmpty: false) |> set(key: "agg", value: "low")
c = base |> aggregateWindow(every: 1h, fn: last,  timeSrc: "_start", createEmpty: false) |> set(key: "agg", value: "close")
n = base |> aggregateWindow(every: 1h, fn: count, timeSrc: "_start", createEmpty: false) |> toFloat() |> set(key: "agg", value: "samples")

union(tables: [o, h, l, c, n])
  |> pivot(rowKey: ["_time"], columnKey: ["agg"], valueColumn: "_value")
  |> keep(columns: ["_time", "open", "high", "low", "close", "samples"])
  |> sort(columns: ["_time"])`;

   const hours = new Map();
   try {
      for (const row of await query(flux)) {
         hours.set(new Date(row._time).getTime(), {
            open: Number(row.open),
            high: Number(row.high),
            low: Number(row.low),
            close: Number(row.close),
            samples: Number(row.samples),
         });
      }
   } catch (error) {
      console.warn(`[${new Date().toISOString()}] Rollup query failed for ${ticker}: ${error.message}`);
   }
   return hours;
}

/** Turns one resolved hour into an InfluxDB point. */
function toPoint(ticker, hourMs, candle, source) {
   const point = new Point(HISTORY_MEASUREMENT)
      .tag('ticker', ticker)
      .floatField('open', candle.open)
      .floatField('high', candle.high)
      .floatField('low', candle.low)
      .floatField('close', candle.close)
      // A field, not a tag: tags are part of the series key, so tagging the source would let a
      // rollup and a candle for the same hour coexist as two points instead of one overwriting
      // the other - and the chart would show a doubled plot point.
      .stringField('source', source)
      .timestamp(new Date(hourMs));

   if (typeof candle.volume === 'number' && !isNaN(candle.volume)) point.floatField('volume', candle.volume);
   if (typeof candle.samples === 'number' && !isNaN(candle.samples)) point.intField('samples', Math.round(candle.samples));
   return point;
}

/**
 * Fills in every hour missing from the history bucket over a range.
 *
 * @param {object} options
 * @param {number} options.startMs - Inclusive start (snapped down to an hour boundary).
 * @param {number} options.stopMs - Exclusive end (snapped down; the in-progress hour is never written).
 * @param {string[]} options.tickers - Tickers to cover.
 * @param {boolean} [options.dryRun] - Resolve everything and report, but write nothing.
 * @param {boolean} [options.force] - Rewrite hours even if they are already present.
 * @returns {Promise<object>} Totals: { written, fromRollup, fromCandles, unresolved }.
 */
async function ensureHourlyCoverage({ startMs, stopMs, tickers, dryRun = false, force = false }) {
   const { writeApi } = getApis();
   const rangeStart = floorHour(startMs);
   // Never write the hour currently in progress - it would be recorded half-formed and, because
   // writes overwrite by timestamp, the partial close would persist until something rewrote it.
   const rangeStop = floorHour(stopMs);
   const expectedSamplesPerHour = Math.max(1, Math.round(60 / M_GRANULARITY));
   const minSamples = Math.max(1, Math.ceil(expectedSamplesPerHour * HISTORY_MIN_ROLLUP_COVERAGE));

   const totals = { written: 0, fromRollup: 0, fromCandles: 0, unresolved: 0 };
   if (rangeStop <= rangeStart) return totals;

   for (const ticker of tickers) {
      for (let chunkStart = rangeStart; chunkStart < rangeStop; chunkStart += CHUNK_HOURS * HOUR_MS) {
         const chunkStop = Math.min(chunkStart + CHUNK_HOURS * HOUR_MS, rangeStop);

         const existing = force ? new Set() : await getExistingHours(ticker, chunkStart, chunkStop);
         const missing = [];
         for (let hour = chunkStart; hour < chunkStop; hour += HOUR_MS) {
            if (!existing.has(hour)) missing.push(hour);
         }
         if (missing.length === 0) continue;

         const resolved = new Map(); // hourMs -> { candle, source }

         // Source 1: our own minute ticks, where they still exist.
         const rollups = await rollupFromMarketData(ticker, missing[0], missing[missing.length - 1] + HOUR_MS);
         let thinHours = 0;
         for (const hour of missing) {
            const rollup = rollups.get(hour);
            if (!rollup) continue;
            if (rollup.samples < minSamples) {
               thinHours++; // Leave it for the candle pass, which sees the whole hour of trades.
               continue;
            }
            resolved.set(hour, { candle: rollup, source: 'rollup' });
         }

         // Source 2: exchange candles for everything the rollup couldn't supply.
         const stillMissing = missing.filter(hour => !resolved.has(hour));
         if (stillMissing.length > 0) {
            try {
               const candles = await fetchHourlyCandles(ticker, stillMissing[0], stillMissing[stillMissing.length - 1] + HOUR_MS);
               for (const hour of stillMissing) {
                  const candle = candles.get(hour);
                  if (candle) resolved.set(hour, { candle, source: 'candles' });
               }
            } catch (error) {
               console.warn(`[${new Date().toISOString()}] Candle backfill unavailable for ${ticker}: ${error.message}`);
            }
         }

         for (const [hour, { candle, source }] of resolved) {
            if (!dryRun) writeApi.writePoint(toPoint(ticker, hour, candle, source));
            totals.written++;
            if (source === 'rollup') totals.fromRollup++; else totals.fromCandles++;
         }
         totals.unresolved += missing.length - resolved.size;

         const window = `${new Date(chunkStart).toISOString().slice(0, 13)}Z..${new Date(chunkStop).toISOString().slice(0, 13)}Z`;
         log(`${dryRun ? '[dry-run] ' : ''}${ticker} ${window}: ${missing.length} missing -> ${resolved.size} resolved (rollup ${[...resolved.values()].filter(r => r.source === 'rollup').length}, candles ${[...resolved.values()].filter(r => r.source === 'candles').length})${thinHours ? `, ${thinHours} thin rollup hour(s) deferred to candles` : ''}${missing.length - resolved.size ? `, ${missing.length - resolved.size} unresolved` : ''}`);
      }
   }

   if (!dryRun && totals.written > 0) {
      await writeApi.flush();
   }
   return totals;
}

/**
 * The scheduled pass run by the live service: re-check a trailing window and fill any hour that is
 * missing. A trailing window (rather than "just the hour that closed") means an outage, a restart,
 * or a transient Coinbase failure repairs itself on the next run with no manual intervention.
 * @param {string[]} tickers
 * @param {number} lookbackHours
 */
async function syncRecentHours(tickers, lookbackHours) {
   const stopMs = floorHour(Date.now());
   const startMs = stopMs - lookbackHours * HOUR_MS;
   const totals = await ensureHourlyCoverage({ startMs, stopMs, tickers });
   if (totals.written > 0 || totals.unresolved > 0) {
      log(`Hourly history sync: wrote ${totals.written} hour(s) (${totals.fromRollup} rollup, ${totals.fromCandles} candles), ${totals.unresolved} unresolved.`);
   }
   return totals;
}

/** Flushes and closes the history write API. */
async function closeHistory() {
   if (writeApi) await writeApi.close();
}

module.exports = {
   ensureHistoryBucket,
   ensureHourlyCoverage,
   syncRecentHours,
   closeHistory,
   floorHour,
   HOUR_MS,
};
