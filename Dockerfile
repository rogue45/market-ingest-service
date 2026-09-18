FROM node:18-alpine AS base
WORKDIR /usr/src/app
COPY package.json ./
RUN npm install --omit=dev
COPY marketIngestService.js config.js hourlyHistory.js coinbaseCandles.js backfill.js ./
COPY config.yml ./
CMD [ "node", "marketIngestService.js" ]