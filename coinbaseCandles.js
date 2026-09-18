/**
 * @fileoverview Historical hourly OHLC candles from Coinbase's public Exchange API.
 *
 * The live ticker in marketIngestService.js only ever knows "the price right now", so it can't
 * reconstruct hours that already passed - which is exactly what a backfill needs. This endpoint is
 * public (no key, no signing), covers years of history, and returns real OHLC per hour.
 */

const axios = require('axios');

const EXCHANGE_API_BASE_URL = 'https://api.exchange.coinbase.com';
const HOUR_SECONDS = 3600;
// Coinbase rejects any request that would span more than 300 candles.
const MAX_CANDLES_PER_REQUEST = 300;
// The public endpoint allows ~10 req/s per IP; stay well under it, we are never in a hurry here.
const REQUEST_SPACING_MS = 250;
const MAX_RETRIES = 4;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Fetches one page of hourly candles.
 * @param {string} ticker - Coinbase product id (e.g. 'BTC-USD').
 * @param {Date} start - Inclusive start of the window.
 * @param {Date} end - Exclusive end of the window.
 * @returns {Promise<Array<Array<number>>>} Raw candle rows: [time, low, high, open, close, volume].
 */
async function fetchCandlePage(ticker, start, end) {
   const url = `${EXCHANGE_API_BASE_URL}/products/${encodeURIComponent(ticker)}/candles`;
   const params = {
      granularity: HOUR_SECONDS,
      start: start.toISOString(),
      end: end.toISOString(),
   };

   let lastError;
   for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
         const response = await axios.get(url, { params, timeout: 20000 });
         if (!Array.isArray(response.data)) {
            throw new Error(`Unexpected candle response shape: ${JSON.stringify(response.data).slice(0, 200)}`);
         }
         return response.data;
      } catch (error) {
         const status = error.response?.status;
         // A product Coinbase Exchange doesn't list will never succeed - don't burn retries on it.
         if (status === 404) {
            throw Object.assign(new Error(`Coinbase Exchange has no product "${ticker}"`), { notFound: true });
         }
         lastError = error;
         if (attempt < MAX_RETRIES) {
            const backoffMs = REQUEST_SPACING_MS * Math.pow(4, attempt); // 1s, 4s, 16s
            console.warn(`[${new Date().toISOString()}] Candle fetch for ${ticker} failed (${status || error.code || error.message}); retrying in ${backoffMs}ms`);
            await sleep(backoffMs);
         }
      }
   }
   throw lastError;
}

/**
 * Fetches hourly candles for a ticker across an arbitrary range, paging around Coinbase's
 * 300-candle cap.
 *
 * Hours in which the product never traded are simply absent from the response; the caller decides
 * what to do about a gap rather than having one silently invented here.
 *
 * @param {string} ticker - Coinbase product id (e.g. 'BTC-USD').
 * @param {number} startMs - Inclusive start, epoch ms (should be an hour boundary).
 * @param {number} stopMs - Exclusive end, epoch ms (should be an hour boundary).
 * @returns {Promise<Map<number, object>>} Hour-start epoch ms -> { open, high, low, close, volume }.
 */
async function fetchHourlyCandles(ticker, startMs, stopMs) {
   const candles = new Map();
   if (stopMs <= startMs) return candles;

   const pageMs = MAX_CANDLES_PER_REQUEST * HOUR_SECONDS * 1000;
   let pageStart = startMs;

   while (pageStart < stopMs) {
      const pageEnd = Math.min(pageStart + pageMs, stopMs);
      // Coinbase treats `end` as inclusive, so ask for the last candle's start rather than the
      // exclusive boundary - otherwise every page quietly includes one hour of the next page.
      const rows = await fetchCandlePage(ticker, new Date(pageStart), new Date(pageEnd - HOUR_SECONDS * 1000));

      for (const row of rows) {
         const [timeSeconds, low, high, open, close, volume] = row;
         const hourMs = timeSeconds * 1000;
         if (hourMs < startMs || hourMs >= stopMs) continue;
         candles.set(hourMs, {
            open: Number(open),
            high: Number(high),
            low: Number(low),
            close: Number(close),
            volume: Number(volume),
         });
      }

      pageStart = pageEnd;
      if (pageStart < stopMs) await sleep(REQUEST_SPACING_MS);
   }

   return candles;
}

module.exports = {
   fetchHourlyCandles,
   HOUR_SECONDS,
};
