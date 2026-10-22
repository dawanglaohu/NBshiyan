import type { PrismaClient } from '@prisma/client';
import { getServerConfig, type ServerConfig } from './config';
import { prisma } from './db';
import { mapAppError, mapUnknownFailure } from './http/errors';
import { createApiCounter, type ApiCounter, type ApiCounterDb, type CounterLog } from './http/metrics';

export type HttpServices = {
  config: ServerConfig;
  mapAppError: typeof mapAppError;
  mapUnknownFailure: typeof mapUnknownFailure;
  apiCounter: ApiCounter;
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
