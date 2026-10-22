import type { PrismaClient } from '@prisma/client';
import { getServerConfig, type ServerConfig } from './config';
import { prisma } from './db';
import { deviceServiceFor, type DeviceSessionService } from './admin/device-session';
import { mapAppError, mapUnknownFailure } from './http/errors';
import { createApiCounter, type ApiCounter, type ApiCounterDb, type CounterLog } from './http/metrics';

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
