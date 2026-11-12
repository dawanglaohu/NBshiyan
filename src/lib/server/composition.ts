import type { PrismaClient } from '@prisma/client';
import { getServerConfig, type ServerConfig } from './config';
import { prisma } from './db';
import { createActionGrantService, type ActionGrantService } from './admin/action-grant';
import { createRecoveryAuthorizationService, type RecoveryAuthorizationService } from './admin/recovery-authorizations';
import { createRecoveryStartService, type RecoveryStartService } from './admin/recovery-start';
import { createRecoveryEnrollmentService, type RecoveryEnrollmentService } from './admin/recovery-enrollment';
import { createAccountSecurityService, type AccountSecurityService } from './admin/account-security';
import { createDeviceManagementService, type DeviceManagementService } from './admin/device-management';
import { deviceServiceFor, type DeviceSessionService } from './admin/device-session';
import { mapAppError, mapUnknownFailure } from './http/errors';
import { createApiCounter, type ApiCounter, type ApiCounterDb, type CounterLog } from './http/metrics';
import { createAnalyticsConsentService, type AnalyticsConsentService } from './analytics/consent';
import { createAnalyticsSettingsService, type AnalyticsSettingsService } from './analytics/settings';
import { createAnalyticsEventRepo } from './analytics/event-repo';
import { createAnalyticsDayMarkerSink } from './analytics/aggregate-day-state';
import { createAnalyticsIngestService, type AnalyticsIngestService } from './analytics/ingest';
import { analyticsConsentSecret } from './config';
import { CHAT_VISITOR_POLICY } from './config';
import { createVisitorSessionRepo, type VisitorSessionStore } from './chat/visitor-session-repo';
import { createVisitorSessionService, type VisitorSessionService } from './chat/visitor-session';
import { createConversationService, type ConversationService } from './chat/conversation-service';
import type { ChatWriteDb } from './chat/repo';
import { createAnalyticsAggregateJob, createJobRegistry, type JobRegistry } from './jobs/registry';
import { createAnalyticsRetentionJob } from './analytics/retention';
import { retentionCleanupMode } from './analytics/retention-plan';
import { createMailQueueJob } from './mail/queue-job';
import { defaultAdapter } from './mail/http';
import { sendAdminAlert } from './mail';
import { audit, auditInTx } from './admin/audit';
import type { AlertFn, AuditFn, AuditInTxFn } from './mail/send';
import type { MailSendAdapter } from './mail/adapter';

export type HttpServices = {
  config: ServerConfig;
  mapAppError: typeof mapAppError;
  mapUnknownFailure: typeof mapUnknownFailure;
  apiCounter: ApiCounter;
};

export type AdminServices = HttpServices & {
  devices: DeviceSessionService;
  actionGrants: ActionGrantService;
  recoveryAuthorizations: RecoveryAuthorizationService;
  recoveryStart: RecoveryStartService;
  recoveryEnrollment: RecoveryEnrollmentService;
  accountSecurity: AccountSecurityService;
  deviceManagement: DeviceManagementService;
  /** 站点统计时区设置；M5-T4 的 settings 工厂只在这里接线。 */
  analyticsSettings: AnalyticsSettingsService;
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
  const actionGrants = createActionGrantService({
    db,
    clock,
    grantTtlMs: config.grant.ttlMs,
    sessionPolicy: config.session,
  });
  return {
    ...createHttpServices({ db, config, clock, log: deps.log }),
    devices: deviceServiceFor(db, clock, config.session),
    actionGrants,
    recoveryAuthorizations: createRecoveryAuthorizationService({
      db,
      clock,
      permitTtlMs: config.grant.permitTtlMs,
      actionGrants,
    }),
    recoveryStart: createRecoveryStartService({
      db,
      clock,
      restrictedTtlMs: config.grant.restrictedTtlMs,
    }),
    recoveryEnrollment: createRecoveryEnrollmentService({
      db,
      clock,
      restrictedTtlMs: config.grant.restrictedTtlMs,
    }),
    accountSecurity: createAccountSecurityService({ db, clock, actionGrants }),
    deviceManagement: createDeviceManagementService({ db, clock, actionGrants, policy: config.session }),
    analyticsSettings: createAnalyticsSettingsService({ db, clock }),
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
      // M5-T12：采集入口默认接通 UTC 日 marker，与事件插入同一事务提交。
      markers: createAnalyticsDayMarkerSink(),
    }),
  };
}

export type ChatServices = HttpServices & {
  visitorSessions: VisitorSessionService;
  conversations: ConversationService;
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
  // 写入面单独取一次：会话 cookie 的窄替身不需要实现会话/消息表，组合点只在真正调用时用到它。
  const chatDb = (deps.db ?? prisma) as unknown as ChatWriteDb;
  return {
    ...http,
    visitorSessions: createVisitorSessionService({
      repo: createVisitorSessionRepo(store),
      clock,
      policy: CHAT_VISITOR_POLICY,
    }),
    conversations: createConversationService({ db: chatDb, clock }),
  };
}

export type JobServices = {
  jobs: JobRegistry;
};

/**
 * 固定作业的生产组合点。只注册已经实现并接线的作业；尚未交付的模块不在这里
 * 注册空实现，也不导入未来服务。registry 本身只认固定 key 与已注册的实现。
 *
 * 分析保留的删除授权只来自容器已文档化的 `RETENTION_CLEANUP_MODE=delete`
 * （同一开关旧清理链也在用）；未设即无生产保留授权，请求 dryRun:false 也只会
 * 记一次拒绝、删 0 行。测试用 `deleteAuthorized` 显式注入，不读环境。
 */
export function createJobServices(deps: {
  db?: PrismaClient;
  clock?: () => Date;
  deleteAuthorized?: boolean;
  /** 邮件队列测试注入点；生产默认用真实 adapter/告警/审计。 */
  mail?: {
    getAdapter?: () => Promise<MailSendAdapter | null>;
    alert?: AlertFn;
    audit?: AuditFn;
    auditInTx?: AuditInTxFn;
    limit?: number;
  };
} = {}): JobServices {
  const db = deps.db ?? (prisma as PrismaClient);
  const deleteAuthorized = deps.deleteAuthorized ?? retentionCleanupMode() === 'delete';
  const mail = deps.mail ?? {};
  const mailJob = createMailQueueJob({
    db,
    ...(deps.clock ? { clock: deps.clock } : {}),
    getAdapter: mail.getAdapter ?? defaultAdapter,
    alert: mail.alert ?? sendAdminAlert,
    audit: mail.audit ?? audit,
    auditInTx: mail.auditInTx ?? auditInTx,
    ...(mail.limit !== undefined ? { limit: mail.limit } : {}),
  });
  return {
    jobs: createJobRegistry([
      createAnalyticsAggregateJob({ db, clock: deps.clock }),
      createAnalyticsRetentionJob({ db, clock: deps.clock, deleteAuthorized }),
      mailJob,
    ]),
  };
}
