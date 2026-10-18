# The swipr app (mock marketplace + ingest worker + indexer + matcher + API) in one container for local use.
FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json search.config.json ./
COPY db ./db
COPY src ./src
ENV BIND_HOST=0.0.0.0
EXPOSE 4200 4210
CMD ["node", "--import", "tsx", "src/dev/all.ts"]
