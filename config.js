/**
 * @fileoverview Shared configuration loading for every entry point in this service
 * (the live ticker, the hourly history job, and the backfill CLI), so they can never
 * disagree about which InfluxDB/bucket/tickers they're working with.
 *
 * Precedence: environment variable > config.yml > built-in default.
 */

const fs = require('fs');
const yaml = require('js-yaml');
const path = require('path');

// Built-in defaults. Anything here can be overridden by config.yml, and then by an env var.
const DEFAULTS = {
   influxdb: {
      url: 'http://localhost:8086',
      token: 'YOUR_INFLUXDB_OPERATOR_OR_BUCKET_TOKEN_DEFAULT', // Fallback, should be in config.yml or ENV
      org: 'myorg_default',
      bucket: 'mybucket_default',
   },
   service: {
      granularityMinutes: 1, // Default granularity
      tickers: ['BTC-USD', 'ETH-USD'], // Default tickers
   },
   // Long-horizon price history: one point per hour, in its own infinite-retention bucket so an
   // "all time" chart survives the 30-day retention on the minute-resolution bucket above.
   history: {
      enabled: true,
      bucket: 'market_history',
      measurement: 'price_hourly',
      // How far back the scheduled job re-checks for missing hours on every run. Covers ordinary
      // restarts/outages without re-scanning the whole archive every hour.
      lookbackHours: 72,
      // Earliest hour the backfill CLI will go when no --start is given.
      backfillStart: '2026-01-01',
      // An hour rolled up from our own minute ticks is only trusted if at least this fraction of the
      // expected samples are present; below it we fall back to exchange candles rather than record a
      // half-empty hour (happens at the retention edge, or after the service was down mid-hour).
      minRollupCoverage: 0.5,
   },
   coinbase: {}, // Placeholder for any Coinbase specific future configs
};

function loadConfig() {
   let config = {
      influxdb: { ...DEFAULTS.influxdb },
      service: { ...DEFAULTS.service },
      history: { ...DEFAULTS.history },
      coinbase: { ...DEFAULTS.coinbase },
   };

   try {
      // Determine config file path. Prioritize CONFIG_PATH environment variable, then default to 'config.yml' in the script's directory.
      const configPath = process.env.CONFIG_PATH || path.join(__dirname, 'config.yml');

      if (fs.existsSync(configPath)) {
         const configFile = fs.readFileSync(configPath, 'utf8'); // Read the YAML file
         const loadedConfig = yaml.load(configFile) || {}; // Parse the YAML content

         // Shallow merge per section: values from loadedConfig overwrite defaults, and sections
         // missing from config.yml keep their defaults entirely.
         config = {
            influxdb: { ...config.influxdb, ...loadedConfig.influxdb },
            service: { ...config.service, ...loadedConfig.service },
            history: { ...config.history, ...loadedConfig.history },
            coinbase: { ...config.coinbase, ...loadedConfig.coinbase },
         };
         console.log(`[${new Date().toISOString()}] Configuration successfully loaded from ${configPath}`);
      } else {
         console.warn(`[${new Date().toISOString()}] Warning: Configuration file not found at ${configPath}.`);
         console.warn(`[${new Date().toISOString()}] Using default values and/or environment variables.`);
      }
   } catch (e) {
      console.error(`[${new Date().toISOString()}] Error loading or parsing configuration file:`, e);
      console.warn(`[${new Date().toISOString()}] Continuing with default values and/or environment variables.`);
   }

   return config;
}

const config = loadConfig();

// Service settings from config, overridden by environment variables if set
const M_GRANULARITY = parseInt(process.env.M_GRANULARITY) || config.service.granularityMinutes;
const M_TICKERS = process.env.M_TICKERS ? process.env.M_TICKERS.split(',') : config.service.tickers;

// InfluxDB settings from config, overridden by environment variables if set
const INFLUXDB_URL = process.env.INFLUXDB_URL || config.influxdb.url;
const INFLUXDB_TOKEN = process.env.INFLUXDB_TOKEN || config.influxdb.token; // CRITICAL: Ensure this is set either in config.yml or as ENV
const INFLUXDB_ORG = process.env.INFLUXDB_ORG || config.influxdb.org;
const INFLUXDB_BUCKET = process.env.INFLUXDB_BUCKET || config.influxdb.bucket;

// Hourly history settings
const HISTORY_ENABLED = process.env.HISTORY_ENABLED
   ? process.env.HISTORY_ENABLED !== 'false'
   : config.history.enabled !== false;
const HISTORY_BUCKET = process.env.HISTORY_BUCKET || config.history.bucket;
const HISTORY_MEASUREMENT = process.env.HISTORY_MEASUREMENT || config.history.measurement;
const HISTORY_LOOKBACK_HOURS = parseInt(process.env.HISTORY_LOOKBACK_HOURS) || config.history.lookbackHours;
const HISTORY_BACKFILL_START = process.env.HISTORY_BACKFILL_START || config.history.backfillStart;
const HISTORY_MIN_ROLLUP_COVERAGE = process.env.HISTORY_MIN_ROLLUP_COVERAGE
   ? parseFloat(process.env.HISTORY_MIN_ROLLUP_COVERAGE)
   : config.history.minRollupCoverage;

module.exports = {
   config,
   M_GRANULARITY,
   M_TICKERS,
   INFLUXDB_URL,
   INFLUXDB_TOKEN,
   INFLUXDB_ORG,
   INFLUXDB_BUCKET,
   HISTORY_ENABLED,
   HISTORY_BUCKET,
   HISTORY_MEASUREMENT,
   HISTORY_LOOKBACK_HOURS,
   HISTORY_BACKFILL_START,
   HISTORY_MIN_ROLLUP_COVERAGE,
};
