/**
 * Where sniper alerts go. Always logged; also pushed to your phone through ntfy when NTFY_TOPIC is set
 * (install the ntfy app, subscribe to the same topic). Uses ntfy's JSON publish API, so titles can hold any text.
 * EXTENSION POINT: add a Telegram or SMS notifier with the same interface.
 */
import type { Redis } from 'ioredis';
import { config } from '../config';
import { logger } from '../runtime';

export interface ListingAlert {
  watchId: string;
  source: string;
  title: string;
  priceCents: number;
  originalPriceCents?: number;
  city?: string;
  region?: string;
  distanceMi: number | null;         // null when the listing's position is unknown
  ageMin: number | null;             // minutes since it was listed, when the source says
  postedAt?: string;                 // ISO time it was listed, when the source says
  url: string;
  imageUrl?: string;
}

export interface Notifier {
  readonly name: string;
  send(alert: ListingAlert): Promise<void>;
}

const SOURCE_NAMES: Record<string, string> = { facebook: 'Facebook', offerup: 'OfferUp', mock: 'Mock' };
const money = (cents: number) => (cents === 0 ? 'Free' : '$' + Math.round(cents / 100).toLocaleString('en-US'));

export function formatAlert(a: ListingAlert): { title: string; message: string } {
  const title = `${money(a.priceCents)} · ${a.title}`.slice(0, 120);
  const where = [a.city && a.region ? `${a.city}, ${a.region}` : a.city, a.distanceMi !== null ? `${Math.round(a.distanceMi)} mi` : null]
    .filter(Boolean).join(' · ');
  const when = a.ageMin === null ? null : a.ageMin < 1 ? 'just listed' : `${Math.round(a.ageMin)} min ago`;
  const was = a.originalPriceCents && a.originalPriceCents > a.priceCents ? `was ${money(a.originalPriceCents)}` : null;
  const lines = [[where, when].filter(Boolean).join(' · '), [SOURCE_NAMES[a.source] ?? a.source, `watch: ${a.watchId}`, was].filter(Boolean).join(' · ')];
  return { title, message: lines.filter(Boolean).join('\n') };
}

export class ConsoleNotifier implements Notifier {
  readonly name = 'console';
  private log = logger('sniper');
  async send(a: ListingAlert) {
    const { title, message } = formatAlert(a);
    this.log(`ALERT ${title} | ${message.replace(/\n/g, ' | ')} | ${a.url}`);
  }
}

export class NtfyNotifier implements Notifier {
  readonly name = 'ntfy';
  constructor(private server: string, private topic: string, private fetchImpl: typeof fetch = fetch) {}

  async send(a: ListingAlert) {
    const { title, message } = formatAlert(a);
    const res = await this.fetchImpl(this.server, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        topic: this.topic,
        title,
        message,
        click: a.url,                                         // tap opens the listing (the Facebook app, if installed)
        ...(a.imageUrl ? { attach: a.imageUrl } : {}),
        priority: a.ageMin !== null && a.ageMin <= 15 ? 4 : 3,
        tags: ['moneybag'],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`ntfy responded ${res.status}`);
  }
}

/** Keeps the latest alerts in Redis so the UI's Sniper tab can show them. */
export const ALERT_LOG_KEY = 'swipr:sniper:alert-log';
export class RedisAlertLog implements Notifier {
  readonly name = 'ui';
  constructor(private redis: Redis) {}
  async send(a: ListingAlert) {
    await this.redis.multi().lpush(ALERT_LOG_KEY, JSON.stringify({ ...a, alertedAt: new Date().toISOString() })).ltrim(ALERT_LOG_KEY, 0, 199).exec();
  }
}

export function createNotifiers(redis?: Redis): Notifier[] {
  const out: Notifier[] = [new ConsoleNotifier()];
  if (redis) out.push(new RedisAlertLog(redis));
  if (config.alerts.ntfyTopic) out.push(new NtfyNotifier(config.alerts.ntfyServer, config.alerts.ntfyTopic));
  return out;
}
