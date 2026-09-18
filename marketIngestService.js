// Import the axios library for making HTTP requests
const axios = require('axios');
// Import the InfluxDB client library
const { InfluxDB, Point } = require('@influxdata/influxdb-client');
// Configuration (config.yml + environment overrides) lives in one shared module so this service,
// the hourly history job and the backfill CLI can never disagree about where they're writing.
const {
   M_GRANULARITY,
   M_TICKERS,
   INFLUXDB_URL,
   INFLUXDB_TOKEN,
   INFLUXDB_ORG,
   INFLUXDB_BUCKET,
   HISTORY_ENABLED,
   HISTORY_BUCKET,
   HISTORY_LOOKBACK_HOURS,
} = require('./config');
// Long-horizon hourly archive: market_data expires after 30 days, so an "all time" view needs a
// second, coarser series that is never expired. See hourlyHistory.js.
const { ensureHistoryBucket, syncRecentHours, closeHistory } = require('./hourlyHistory');

// Coinbase API base URL (currently static, but could be made configurable)
const COINBASE_API_BASE_URL = 'https://api.coinbase.com/v2/prices/';

// Initialize InfluxDB client
let influxDB;
let writeApi;

try {
   // These values (INFLUXDB_URL, INFLUXDB_TOKEN, etc.) are now derived from config.yml or ENV
   influxDB = new InfluxDB({ url: INFLUXDB_URL, token: INFLUXDB_TOKEN });
   writeApi = influxDB.getWriteApi(INFLUXDB_ORG, INFLUXDB_BUCKET);
   console.log(`[${new Date().toISOString()}] InfluxDB WriteAPI: Initializing for org: '${INFLUXDB_ORG}', bucket: '${INFLUXDB_BUCKET}', url: '${INFLUXDB_URL}'`);
} catch(e) {
   console.error(`[${new Date().toISOString()}] FATAL: Could not initialize InfluxDB client. Check configuration (URL, Token, Org, Bucket). Error: ${e.message}`);
   process.exit(1); // Exit if InfluxDB client cannot be initialized
}

// --- Helper Functions ---

/**
 * Fetches the spot price for a given ticker from the Coinbase API.
 * @param {string} ticker - The currency pair (e.g., 'BTC-USD').
 * @returns {Promise<object|null>} A promise that resolves with the price data or null if an error occurs.
 */
async function fetchSpotPrice(ticker) {
   const apiUrl = `${COINBASE_API_BASE_URL}${ticker}/spot`;
   try {
      const response = await axios.get(apiUrl);
      if (response.status === 200 && response.data && response.data.data) {
         return {
            ticker: ticker,
            price: parseFloat(response.data.data.amount), // Ensure price is a number
            currency: response.data.data.currency,
            timestamp: new Date() // Use current Date object for InfluxDB
         };
      } else {
         console.error(`[${new Date().toISOString()}] Error fetching ${ticker}: Invalid response structure`, response.data);
         return null;
      }
   } catch (error) {
      if (error.response) {
         console.error(`[${new Date().toISOString()}] Error fetching ${ticker}: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
      } else if (error.request) {
         console.error(`[${new Date().toISOString()}] Error fetching ${ticker}: No response received`, error.request);
      } else {
         console.error(`[${new Date().toISOString()}] Error fetching ${ticker}:`, error.message);
      }
      return null;
   }
}

/**
 * Writes a price data point to InfluxDB.
 * @param {object} priceData - The price data object from fetchSpotPrice.
 */
async function writeToInfluxDB(priceData) {
   if (!priceData || typeof priceData.price !== 'number') {
      console.error(`[${priceData.timestamp.toISOString()}] Invalid price data for InfluxDB, skipping write:`, priceData);
      return;
   }

   const point = new Point('spot_price') // Measurement name
      .tag('ticker', priceData.ticker) // Tag for the currency pair
      .tag('source', 'coinbase')      // Tag for the data source
      .floatField('price', priceData.price) // Field for the price
      .timestamp(priceData.timestamp); // Timestamp for the data point

   try {
      writeApi.writePoint(point);
      // For immediate flushing (useful for testing, can be batched for production)
      // await writeApi.flush();
      console.log(`[${priceData.timestamp.toISOString()}] InfluxDB WRITE: ${priceData.ticker} - ${priceData.price} ${priceData.currency}`);
   } catch (error) {
      console.error(`[${priceData.timestamp.toISOString()}] Error writing to InfluxDB for ${priceData.ticker}:`, error);
   }
}

/**
 * Main function to fetch prices for all configured tickers and store them.
 */
async function fetchAndStoreAllPrices() {
   console.log(`[${new Date().toISOString()}] --- Starting price fetch & store cycle for ${M_TICKERS.join(', ')} ---`);

   const fetchPromises = M_TICKERS.map(ticker => fetchSpotPrice(ticker));
   const results = await Promise.allSettled(fetchPromises);

   for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
         const priceData = result.value;
         console.log(`[${priceData.timestamp.toISOString()}] API FETCHED: ${priceData.ticker} - ${priceData.price} ${priceData.currency}`);
         await writeToInfluxDB(priceData); // Write to InfluxDB
      } else if (result.status === 'rejected') {
         // Error already logged in fetchSpotPrice
      }
   }

   // Batch writes are often flushed periodically or on close.
   // For this script, flushing after each cycle ensures data is written.
   try {
      await writeApi.flush();
      console.log(`[${new Date().toISOString()}] InfluxDB data flushed.`);
   } catch (e) {
      console.error(`[${new Date().toISOString()}] Error flushing InfluxDB data:`, e);
   }

   console.log(`[${new Date().toISOString()}] --- Price fetch & store cycle completed ---`);
}

/**
 * Starts the hourly history job.
 *
 * Runs shortly after each hour closes (and once at startup, to catch up on anything missed while
 * the service was down), re-checking a trailing window rather than only the hour that just ended -
 * so a restart or a transient outage repairs itself without anyone running the backfill by hand.
 * @param {string[]} tickersToWatch - An array of tickers.
 */
async function startHourlyHistoryJob(tickersToWatch) {
   if (!HISTORY_ENABLED) {
      console.log(`[${new Date().toISOString()}] Hourly history archive disabled (history.enabled=false); long-range charts will be limited to the retention window of '${INFLUXDB_BUCKET}'.`);
      return;
   }

   const ready = await ensureHistoryBucket();
   if (!ready) {
      console.error(`[${new Date().toISOString()}] Hourly history archive unavailable; continuing with minute ingest only.`);
      return;
   }

   console.log(`[${new Date().toISOString()}] Hourly history archive: bucket='${HISTORY_BUCKET}', re-checking the last ${HISTORY_LOOKBACK_HOURS}h every hour.`);

   const runSync = async () => {
      try {
         await syncRecentHours(tickersToWatch, HISTORY_LOOKBACK_HOURS);
      } catch (e) {
         // Never let the history job take down minute ingest - it is a strictly additive archive.
         console.error(`[${new Date().toISOString()}] Hourly history sync failed:`, e.message);
      }
   };

   await runSync(); // Catch up immediately on startup.

   // Fire a few minutes past the hour so the hour is fully closed and its final ticks have landed.
   const HOUR_MS = 60 * 60 * 1000;
   const OFFSET_MS = 2 * 60 * 1000;
   const now = Date.now();
   const nextRun = Math.floor(now / HOUR_MS) * HOUR_MS + HOUR_MS + OFFSET_MS;
   setTimeout(() => {
      runSync();
      setInterval(runSync, HOUR_MS);
   }, nextRun - now);
}

/**
 * Starts the service.
 * @param {number} granularityMinutes - The interval in minutes (1-5).
 * @param {string[]} tickersToWatch - An array of tickers.
 */
function startService(granularityMinutes, tickersToWatch) {
   if (granularityMinutes < 1 || granularityMinutes > 5) {
      console.error("Error: Granularity must be between 1 and 5 minutes.");
      process.exit(1);
   }
   if (!Array.isArray(tickersToWatch) || tickersToWatch.length === 0) {
      console.error("Error: Tickers array cannot be empty.");
      process.exit(1);
   }
   if (INFLUXDB_TOKEN === 'YOUR_INFLUXDB_OPERATOR_OR_BUCKET_TOKEN' || !INFLUXDB_TOKEN) {
      console.error("Error: InfluxDB token is not configured. Please set INFLUXDB_TOKEN in the script.");
      process.exit(1);
   }


   const intervalMilliseconds = granularityMinutes * 60 * 1000;

   console.log(`[${new Date().toISOString()}] Coinbase to InfluxDB Service started.`);
   console.log(`[${new Date().toISOString()}] Watching tickers: ${tickersToWatch.join(', ')}`);
   console.log(`[${new Date().toISOString()}] Fetching prices every ${granularityMinutes} minute(s).`);
   console.log(`[${new Date().toISOString()}] Writing to InfluxDB: URL=${INFLUXDB_URL}, Org=${INFLUXDB_ORG}, Bucket=${INFLUXDB_BUCKET}`);


   fetchAndStoreAllPrices();
   setInterval(fetchAndStoreAllPrices, intervalMilliseconds); // Subsequent fetches

   startHourlyHistoryJob(tickersToWatch); // Independent cadence; deliberately not awaited.
}

// --- Service Entry Point ---
// To run the service:
// 1. Make sure Node.js and Docker are installed.
// 2. Have InfluxDB running (e.g., using the docker-compose.yml).
// 3. Save this file (e.g., `coinbaseInfluxService.js`).
// 4. Install dependencies: `npm install axios @influxdata/influxdb-client`
// 5. !! IMPORTANT !! Update `INFLUXDB_TOKEN` in this script with your actual InfluxDB token.
// 6. Run the script: `node coinbaseInfluxService.js`

if (require.main === module) {
   startService(M_GRANULARITY, M_TICKERS);
}

// Graceful shutdown
process.on('SIGINT', async () => {
   console.log(`[${new Date().toISOString()}] SIGINT received, shutting down gracefully...`);
   try {
      await writeApi.close();
      await closeHistory();
      console.log(`[${new Date().toISOString()}] InfluxDB write API closed.`);
   } catch (e) {
      console.error(`[${new Date().toISOString()}] Error closing InfluxDB write API:`, e);
   }
   process.exit(0);
});

module.exports = {
   fetchSpotPrice,
   writeToInfluxDB,
   fetchAndStoreAllPrices,
   startHourlyHistoryJob,
   startService
};