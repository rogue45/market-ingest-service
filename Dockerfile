FROM node:18-alpine AS base
WORKDIR /usr/src/app
COPY package.json ./
RUN npm install --omit=dev
COPY marketIngestService.js ./
COPY config.yml ./
CMD [ "node", "marketIngestService.js" ]