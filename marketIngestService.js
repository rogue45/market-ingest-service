// Import the axios library for making HTTP requests
const axios = require('axios');
// Import the InfluxDB client library
const { InfluxDB, Point } = require('@influxdata/influxdb-client');
const fs = require('fs');
const yaml = require('js-yaml');
const path = require('path');

// --- Configuration ---
// --- Configuration Loading ---
// Default configuration values. These will be used if not found in config.yml or environment variables.
let config = {
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
   coinbase: {} // Placeholder for any Coinbase specific future configs
};

try {
   // Determine config file path. Prioritize CONFIG_PATH environment variable, then default to 'config.yml' in the script's directory.
   const configPath = process.env.CONFIG_PATH || path.join(__dirname, 'config.yml');

   // Check if the config file exists
   if (fs.existsSync(configPath)) {
      const configFile = fs.readFileSync(configPath, 'utf8'); // Read the YAML file
      const loadedConfig = yaml.load(configFile); // Parse the YAML content

      // Deep merge loaded config with defaults. Values from loadedConfig will overwrite defaults.
      // This ensures that if config.yml is partially filled, defaults are used for missing parts.
      config = {
         influxdb: { ...config.influxdb, ...loadedConfig.influxdb },
         service: { ...config.service, ...loadedConfig.service },
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

// Service settings from config, overridden by environment variables if set
const M_GRANULARITY = parseInt(process.env.M_GRANULARITY) || config.service.granularityMinutes;
const M_TICKERS = process.env.M_TICKERS ? process.env.M_TICKERS.split(',') : config.service.tickers;

// InfluxDB settings from config, overridden by environment variables if set
const INFLUXDB_URL = process.env.INFLUXDB_URL || config.influxdb.url;
const INFLUXDB_TOKEN = process.env.INFLUXDB_TOKEN || config.influxdb.token; // CRITICAL: Ensure this is set either in config.yml or as ENV
const INFLUXDB_ORG = process.env.INFLUXDB_ORG || config.influxdb.org;
const INFLUXDB_BUCKET = process.env.INFLUXDB_BUCKET || config.influxdb.bucket;

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
   startService
};