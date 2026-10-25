import { createHmac } from 'node:crypto';
import { products } from '../../../data/products';
import {
  AnalyticsEventsRequestSchema,
  AnalyticsReceiptDTOSchema,
  type AnalyticsEventDTO,
  type AnalyticsReceiptDTO,
} from '../../contracts/analytics';
import { isDbUnavailable } from '../designs';
import { AppError } from '../http/errors';
import { AnalyticsPayloadConflict, type AnalyticsEventRepo, type NewAnalyticsEvent } from './event-repo';

/** 目录产品的内部 key。分析事件不使用 categoryMeta 的本地化 URL slug。 */
export const CATALOG_PRODUCT_SLUGS: ReadonlySet<string> = new Set(products.map((product) => product.slug));

export const ANALYTICS_EVENTS_MAX_BYTES = 32 * 1024;
export const ANALYTICS_EVENTS_COOKIE_LIMIT = 120;
export const ANALYTICS_EVENTS_IP_LIMIT = 300;
export const ANALYTICS_EVENTS_WINDOW_MS = 60_000;
export const ANALYTICS_EVENTS_RETRY_AFTER_SECONDS = 60;
export const ANALYTICS_EVENTS_COOKIE_PREFIX = 'analytics:events:cookie:';
export const ANALYTICS_EVENTS_IP_PREFIX = 'analytics:events:ip:';

const PAST_MS = 48 * 60 * 60 * 1000;
const FUTURE_MS = 5 * 60 * 1000;
const PAYLOAD_LABEL = 'analytics-event-payload-v1';

export type AnalyticsIngestService = {
  accept(raw: unknown, browserHash: string): Promise<AnalyticsReceiptDTO>;
};

export function createAnalyticsIngestService(deps: {
  repo: AnalyticsEventRepo;
  secret: Buffer | null;
  clock?: () => Date;
}): AnalyticsIngestService {
  const clock = deps.clock ?? (() => new Date());
  return {
    async accept(raw, browserHash) {
      if (!Buffer.isBuffer(deps.secret) || deps.secret.length < 32) throw new AppError('service_unavailable');
      if (containsSensitiveAnalyticsPath(raw)) {
        throw new AppError('invalid', { fieldErrors: { events: 'Path must stay a site path without a query or a full URL.' } });
      }
      const parsed = AnalyticsEventsRequestSchema.safeParse(raw);
      if (!parsed.success) throw new AppError('invalid', { fieldErrors: { events: 'Events must match the strict whitelist.' } });
      const now = clock();
      const nowMs = now.getTime();
      if (!Number.isFinite(nowMs)) throw new AppError('service_unavailable');
      if (parsed.data.events.some((event) => !occurredAtInWindow(event.occurredAt, nowMs))) {
        throw new AppError('event_time_out_of_range');
      }
      const slugs = productSlugs(parsed.data.events);
      if (slugs.length > 0 && !await catalogOrPublished(deps.repo, slugs)) {
        throw new AppError('invalid', { fieldErrors: { productSlug: 'Must be a published product.' } });
      }
      const rows = parsed.data.events.map((event) => toRow(event, browserHash, deps.secret as Buffer, now));
      let outcomes: Array<'created' | 'duplicate'>;
      try {
        outcomes = await deps.repo.saveAll(rows);
      } catch (error) {
        if (isPayloadConflict(error)) {
          throw new AppError('idempotency_conflict', {
            fieldErrors: { events: 'This event was already stored with different content.' },
          });
        }
        if (isDbUnavailable(error)) throw new AppError('service_unavailable');
        throw error;
      }
      if (outcomes.length !== rows.length) throw new AppError('service_unavailable');
      const acceptedIds: string[] = [];
      const duplicateIds: string[] = [];
      parsed.data.events.forEach((event, index) => {
        if (outcomes[index] === 'duplicate') duplicateIds.push(event.eventId);
        else acceptedIds.push(event.eventId);
      });
      return AnalyticsReceiptDTOSchema.parse({ acceptedIds, duplicateIds, receivedAt: now.toISOString() });
    },
  };
}

/** 批次里能按条计数时返回条数，否则按一次尝试计。超过 20 条仍算一次，交给 schema 拒绝。 */
export function analyticsEventsAttemptCount(raw: unknown): number {
  if (!raw || typeof raw !== 'object' || !('events' in raw)) return 1;
  const events = (raw as { events?: unknown }).events;
  if (!Array.isArray(events) || events.length < 1 || events.length > 20) return 1;
  return events.length;
}

/** 查询串、片段、绝对 URL 和邮箱样式都不能进 path。契约会剥掉查询，所以要在解析前拒绝。 */
export function containsSensitiveAnalyticsPath(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || !('events' in raw)) return false;
  const events = (raw as { events?: unknown }).events;
  if (!Array.isArray(events)) return false;
  return events.some((event) => {
    if (!event || typeof event !== 'object' || !('path' in event)) return false;
    const path = (event as { path?: unknown }).path;
    return typeof path === 'string' && sensitivePath(path);
  });
}

function sensitivePath(path: string): boolean {
  if (/[?#\\@]/.test(path) || path.includes('://')) return true;
  return /%(?:3f|23|40|5c)/i.test(path);
}

function occurredAtInWindow(occurredAt: string, nowMs: number): boolean {
  const at = Date.parse(occurredAt);
  return Number.isFinite(at) && at >= nowMs - PAST_MS && at <= nowMs + FUTURE_MS;
}

/** 内部 key 直接放行。其余 slug 必须是已发布且 READY 的 Model3D。任一不在白名单则整批无效。 */
async function catalogOrPublished(repo: AnalyticsEventRepo, slugs: readonly string[]): Promise<boolean> {
  const external = slugs.filter((slug) => !CATALOG_PRODUCT_SLUGS.has(slug));
  if (external.length === 0) return true;
  let published: Set<string>;
  try {
    published = await repo.publishedSlugs(external);
  } catch (error) {
    if (isDbUnavailable(error)) throw new AppError('service_unavailable');
    throw error;
  }
  return external.every((slug) => published.has(slug));
}

function productSlugs(events: readonly AnalyticsEventDTO[]): string[] {
  const slugs = new Set<string>();
  for (const event of events) {
    if (event.kind === 'page_view') continue;
    if (event.productSlug) slugs.add(event.productSlug);
  }
  return [...slugs];
}

function toRow(event: AnalyticsEventDTO, browserHash: string, secret: Buffer, receivedAt: Date): NewAnalyticsEvent {
  return {
    eventId: event.eventId,
    semanticKey: semanticKey(browserHash, event),
    payloadHash: payloadHash(secret, event),
    browserHash,
    kind: event.kind,
    occurredAt: new Date(event.occurredAt),
    receivedAt,
    locale: event.locale,
    path: 'path' in event && event.path !== undefined ? event.path : null,
    productSlug: 'productSlug' in event && event.productSlug !== undefined ? event.productSlug : null,
    navigationId: event.navigationId,
    viewId: 'viewId' in event ? event.viewId : null,
    durationMs: 'durationMs' in event ? event.durationMs : null,
    failureReason: event.kind === 'model_load_failure' ? event.failureReason : null,
  };
}

function semanticKey(browserHash: string, event: AnalyticsEventDTO): string {
  switch (event.kind) {
    case 'page_view':
      return join(browserHash, 'page_view', event.navigationId);
    case 'product_view':
      return join(browserHash, 'product_view', event.navigationId, event.productSlug);
    case 'model_view_start':
      return join(browserHash, 'model_view_start', event.viewId);
    case 'model_load_success':
    case 'model_load_failure':
      return join(browserHash, 'model_terminal', event.viewId);
    case 'chat_start':
      return join(browserHash, 'chat_start', event.navigationId);
    default: {
      const unreachable: never = event;
      throw new Error(String(unreachable));
    }
  }
}

function join(...parts: string[]): string {
  return parts.join('\u001f');
}

function payloadHash(secret: Buffer, event: AnalyticsEventDTO): string {
  const fields: Record<string, string | number> = {
    kind: event.kind,
    occurredAt: event.occurredAt,
    locale: event.locale,
    navigationId: event.navigationId,
  };
  if ('viewId' in event) fields.viewId = event.viewId;
  if ('productSlug' in event && event.productSlug !== undefined) fields.productSlug = event.productSlug;
  if ('path' in event && event.path !== undefined) fields.path = event.path;
  if ('durationMs' in event) fields.durationMs = event.durationMs;
  if (event.kind === 'model_load_failure') fields.failureReason = event.failureReason;
  const canonical = JSON.stringify(Object.keys(fields).sort().map((key) => [key, fields[key]]));
  const key = createHmac('sha256', secret).update(PAYLOAD_LABEL).digest();
  return createHmac('sha256', key).update(canonical).digest('base64url');
}

function isPayloadConflict(error: unknown): boolean {
  if (error instanceof AnalyticsPayloadConflict) return true;
  return error instanceof Error && error.cause !== undefined && isPayloadConflict(error.cause);
}
