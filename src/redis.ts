import { Redis } from 'ioredis';
import { config } from './config';

const url = new URL(config.redisUrl);

/** Connection options for BullMQ (it creates and owns its own connections). */
export const bullConnection = {
  host: url.hostname,
  port: Number(url.port || 6379),
  password: url.password || undefined,
  maxRetriesPerRequest: null,
};

export const createRedis = () => new Redis(config.redisUrl);

/** Pub/sub channel the matcher publishes saved-search matches on. */
export const ALERTS_CHANNEL = 'swipr:alerts';
