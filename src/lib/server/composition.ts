import type { PrismaClient } from '@prisma/client';
import { getServerConfig, type ServerConfig } from './config';
import { prisma } from './db';
import { deviceServiceFor, type DeviceSessionService } from './admin/device-session';
import { mapAppError, mapUnknownFailure } from './http/errors';
import { createApiCounter, type ApiCounter, type ApiCounterDb, type CounterLog } from './http/metrics';
import { createAnalyticsConsentService, type AnalyticsConsentService } from './analytics/consent';
import { createAnalyticsEventRepo } from './analytics/event-repo';
import { createAnalyticsIngestService, type AnalyticsIngestService } from './analytics/ingest';
import { analyticsConsentSecret } from './config';
import { CHAT_VISITOR_POLICY } from './config';
import { createVisitorSessionRepo, type VisitorSessionStore } from './chat/visitor-session-repo';
import { createVisitorSessionService, type VisitorSessionService } from './chat/visitor-session';

export type HttpServices = {
  config: ServerConfig;
  mapAppError: typeof mapAppError;
  mapUnknownFailure: typeof mapUnknownFailure;
  apiCounter: ApiCounter;
};

export type AdminServices = HttpServices & {
  devices: DeviceSessionService;
};

/** 新 HTTP 层的组装点。路由在最终响应处调用 apiCounter，不在这里发请求。 */
export function createHttpServices(deps: {
  db?: ApiCounterDb;
  config?: ServerConfig;
  clock?: () => Date;
  log?: (event: CounterLog) => void;
} = {}): HttpServices {
  const db = deps.db ?? (prisma as PrismaClient);
  return {
    config: deps.config ?? getServerConfig(),
    mapAppError,
    mapUnknownFailure,
    apiCounter: createApiCounter({ db, clock: deps.clock, log: deps.log }),
  };
}

/** 后台设备会话和共享 HTTP 层的组装点。每次调用新建服务对象，不保存当前用户。 */
export function createAdminServices(deps: {
  db?: PrismaClient;
  config?: ServerConfig;
  clock?: () => Date;
  log?: (event: CounterLog) => void;
} = {}): AdminServices {
  const db = deps.db ?? (prisma as PrismaClient);
  const config = deps.config ?? getServerConfig();
  const clock = deps.clock ?? (() => new Date());
  return {
    ...createHttpServices({ db, config, clock, log: deps.log }),
    devices: deviceServiceFor(db, clock, config.session),
  };
}

export type AnalyticsConsentServices = HttpServices & {
  consent: AnalyticsConsentService;
};

/** 分析同意验签。每次调用新建服务，密钥只留在同意服务里，不写进冻结配置。 */
export function createAnalyticsConsentServices(deps: {
  db?: ApiCounterDb;
  config?: ServerConfig;
  clock?: () => Date;
  log?: (event: CounterLog) => void;
  env?: Record<string, string | undefined>;
  secret?: Buffer | null;
  randomId?: () => string;
} = {}): AnalyticsConsentServices {
  return {
    ...createHttpServices({ db: deps.db, config: deps.config, clock: deps.clock, log: deps.log }),
    consent: createAnalyticsConsentService({
      secret: deps.secret,
      env: deps.env,
      clock: deps.clock,
      randomId: deps.randomId,
    }),
  };
}

export type AnalyticsIngestServices = AnalyticsConsentServices & {
  ingest: AnalyticsIngestService;
};

/** 分析事件入库。同意验签与载荷哈希共用同一次解析出的密钥，不写进冻结配置。 */
export function createAnalyticsIngestServices(deps: {
  db?: PrismaClient;
  config?: ServerConfig;
  clock?: () => Date;
  log?: (event: CounterLog) => void;
  env?: Record<string, string | undefined>;
  secret?: Buffer | null;
  randomId?: () => string;
} = {}): AnalyticsIngestServices {
  const db = deps.db ?? (prisma as PrismaClient);
  const secret = deps.secret !== undefined ? deps.secret : (deps.env ? analyticsConsentSecret(deps.env) : null);
  return {
    ...createAnalyticsConsentServices({
      db,
      config: deps.config,
      clock: deps.clock,
      log: deps.log,
      env: deps.env,
      secret,
      randomId: deps.randomId,
    }),
    ingest: createAnalyticsIngestService({
      repo: createAnalyticsEventRepo(db),
      secret,
      clock: deps.clock,
    }),
  };
}

export type ChatServices = HttpServices & {
  visitorSessions: VisitorSessionService;
};

/** 访客必要会话。每次调用新建服务，不保存当前 cookie 或会话行。 */
export function createChatServices(deps: {
  db?: ApiCounterDb & VisitorSessionStore;
  config?: ServerConfig;
  clock?: () => Date;
  log?: (event: CounterLog) => void;
} = {}): ChatServices {
  const clock = deps.clock ?? (() => new Date());
  const http = createHttpServices({ db: deps.db, config: deps.config, clock, log: deps.log });
  const store = (deps.db ?? prisma) as unknown as VisitorSessionStore;
  return {
    ...http,
    visitorSessions: createVisitorSessionService({
      repo: createVisitorSessionRepo(store),
      clock,
      policy: CHAT_VISITOR_POLICY,
    }),
  };
}
