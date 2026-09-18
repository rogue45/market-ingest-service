#!/usr/bin/env node
/**
 * @fileoverview One-shot CLI that populates the hourly history bucket over an arbitrary range.
 *
 * Run it once to seed the archive back to the start of the year (or wherever you want the all-time
 * chart to begin); after that the live service keeps the archive current on its own. Re-running is
 * harmless - already-populated hours are skipped, and anything it does rewrite overwrites in place.
 *
 * Usage:
 *   node backfill.js                            # from history.backfillStart in config.yml to now
 *   node backfill.js --start 2026-01-01
 *   node backfill.js --start 2026-01-01 --stop 2026-03-01
 *   node backfill.js --tickers BTC-USD,ETH-USD
 *   node backfill.js --dry-run                  # report what it would write, write nothing
 *   node backfill.js --force                    # rewrite hours that are already present
 */

const { M_TICKERS, HISTORY_BACKFILL_START, HISTORY_BUCKET, INFLUXDB_ORG, INFLUXDB_URL } = require('./config');
const { ensureHistoryBucket, ensureHourlyCoverage, closeHistory, floorHour } = require('./hourlyHistory');

/** Minimal flag parser: --key value, plus bare --flag booleans. */
function parseArgs(argv) {
   const args = {};
   for (let i = 0; i < argv.length; i++) {
      const token = argv[i];
      if (!token.startsWith('--')) continue;
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
         args[key] = next;
         i++;
      } else {
         args[key] = true;
      }
   }
   return args;
}

/** Accepts either a bare date ('2026-01-01', treated as UTC midnight) or a full timestamp. */
function parseWhen(value, label) {
   const iso = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value;
   const ms = new Date(iso).getTime();
   if (isNaN(ms)) {
      console.error(`Invalid --${label}: "${value}". Use YYYY-MM-DD or an ISO 8601 timestamp.`);
      process.exit(1);
   }
   return ms;
}

async function main() {
   const args = parseArgs(process.argv.slice(2));

   const startMs = floorHour(parseWhen(String(args.start || HISTORY_BACKFILL_START), 'start'));
   const stopMs = floorHour(args.stop ? parseWhen(String(args.stop), 'stop') : Date.now());
   const tickers = args.tickers ? String(args.tickers).split(',').map(t => t.trim()).filter(Boolean) : M_TICKERS;
   const dryRun = Boolean(args['dry-run']);
   const force = Boolean(args.force);

   if (stopMs <= startMs) {
      console.error(`--stop (${new Date(stopMs).toISOString()}) must be after --start (${new Date(startMs).toISOString()}).`);
      process.exit(1);
   }

   const totalHours = (stopMs - startMs) / (3600 * 1000);
   console.log(`[${new Date().toISOString()}] Backfilling hourly history${dryRun ? ' (DRY RUN - nothing will be written)' : ''}`);
   console.log(`  target:  ${INFLUXDB_URL} org=${INFLUXDB_ORG} bucket=${HISTORY_BUCKET}`);
   console.log(`  range:   ${new Date(startMs).toISOString()} -> ${new Date(stopMs).toISOString()} (${totalHours} hours)`);
   console.log(`  tickers: ${tickers.join(', ')}`);
   if (force) console.log('  force:   rewriting hours even if already present');

   if (!dryRun) {
      const ready = await ensureHistoryBucket();
      if (!ready) process.exit(1);
   }

   const started = Date.now();
   const totals = await ensureHourlyCoverage({ startMs, stopMs, tickers, dryRun, force });
   const elapsed = ((Date.now() - started) / 1000).toFixed(1);

   console.log(`[${new Date().toISOString()}] Backfill ${dryRun ? 'dry run ' : ''}complete in ${elapsed}s.`);
   console.log(`  hours ${dryRun ? 'resolved' : 'written'}: ${totals.written} (${totals.fromRollup} from our minute ticks, ${totals.fromCandles} from Coinbase candles)`);
   if (totals.unresolved > 0) {
      console.log(`  unresolved hours: ${totals.unresolved} (no ticks and no candle - e.g. a product that wasn't trading yet)`);
   }

   await closeHistory();
}

main().catch(async (error) => {
   console.error(`[${new Date().toISOString()}] Backfill failed:`, error);
   await closeHistory().catch(() => {});
   process.exit(1);
});
