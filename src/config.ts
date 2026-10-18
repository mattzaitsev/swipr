// Every setting has a default that matches docker-compose.yml, so .env is optional.
try {
  process.loadEnvFile();
} catch {
  // no .env file: use defaults
}

const env = (key: string, fallback: string) => process.env[key] || fallback;
const num = (key: string, fallback: number) => Number(env(key, String(fallback)));

export const config = {
  databaseUrl: env('DATABASE_URL', 'postgres://swipr:swipr@localhost:5433/swipr'),
  redisUrl: env('REDIS_URL', 'redis://localhost:6379'),
  typesense: {
    url: env('TYPESENSE_URL', 'http://localhost:8108'),
    apiKey: env('TYPESENSE_API_KEY', 'swipr-dev-key'),
    alias: 'listings',                       // searches go through the alias; collections are listings_v1, _v2, ...
  },
  apiPort: num('API_PORT', 4200),
  ingest: {
    everyMs: num('INGEST_EVERY_MS', 20_000),
    concurrency: num('INGEST_CONCURRENCY', 2),
  },
  mock: {
    port: num('MOCK_SOURCE_PORT', 4210),
    url: env('MOCK_SOURCE_URL', 'http://localhost:4210'),
    tickMs: num('MOCK_TICK_MS', 8_000),
    failRate: num('MOCK_FAIL_RATE', 0),
  },
  demoQueries: env('DEMO_QUERIES', 'couch,bike,desk').split(',').map((q) => q.trim()).filter(Boolean),
};
