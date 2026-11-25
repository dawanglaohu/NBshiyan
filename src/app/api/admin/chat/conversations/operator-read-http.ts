import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { CHAT_BODY_MAX_BYTES } from '@/lib/chat/rules';
import { ChatConversationParamsSchema } from '@/lib/contracts/chat';
import { AppErrorCodeSchema } from '@/lib/contracts/errors';
import { assertSameOrigin, enforceAdminUserRateLimit, requireAdmin } from '@/lib/server/auth';
import { withClearedSession } from '@/lib/server/admin/guard';
import { ChatTransactionBudgetExceeded, isDatabaseUnavailable } from '@/lib/server/chat/repo';
import { createChatServices } from '@/lib/server/composition';
import { AppError, isAppError, mapAppError, mapUnknownFailure } from '@/lib/server/http/errors';
import type { ApiRouteId } from '@/lib/server/http/metrics';
import { readBody } from '@/lib/server/security';

type Gate = Awaited<ReturnType<typeof requireAdmin>>;
type Operator = Exclude<Gate, Response>;
type ChatServices = ReturnType<typeof createChatServices>;

const SYNC_LIMIT = 60;
const WRITE_LIMIT = 30;
const CACHE_CONTROL = 'private, no-store';

export type ConversationParams = { params: Promise<{ id: string }> };

export async function conversationId(params: ConversationParams['params']) {
  const parsed = ChatConversationParamsSchema.safeParse(await params);
  if (!parsed.success) throw new AppError('not_found');
  return parsed.data.id;
}

export function parseInput<Schema extends z.ZodTypeAny>(schema: Schema, input: unknown): z.output<Schema> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new AppError('invalid');
  return parsed.data;
}

export function queryInput(request: Request) {
  const params = new URL(request.url).searchParams;
  const input = Object.fromEntries(params);
  if (Object.keys(input).length !== params.size) throw new AppError('invalid');
  return input;
}

export async function writeInput<Schema extends z.ZodTypeAny>(request: Request, schema: Schema): Promise<z.output<Schema>> {
  const raw = await readBody(request, CHAT_BODY_MAX_BYTES);
  if (raw === null) throw new AppError('too_large');
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new AppError('invalid');
  }
  return parseInput(schema, payload);
}

export function handleOperatorRead(
  request: Request,
  routeId: ApiRouteId,
  authorize: () => Promise<Gate>,
  run: (operator: Operator, service: ChatServices['operatorRead']) => Promise<unknown>,
) {
  return handleOperatorRequest(request, routeId, authorize, 'chat.sync', SYNC_LIMIT,
    (operator, services) => run(operator, services.operatorRead));
}

export function handleOperatorWrite(
  request: Request,
  routeId: ApiRouteId,
  authorize: () => Promise<Gate>,
  run: (operator: Operator, service: ChatServices['operatorWrite']) => Promise<unknown>,
) {
  return handleOperatorRequest(request, routeId, authorize, 'chat.write', WRITE_LIMIT,
    (operator, services) => run(operator, services.operatorWrite));
}

async function handleOperatorRequest(
  request: Request,
  routeId: ApiRouteId,
  authorize: () => Promise<Gate>,
  rateKey: string,
  rateLimit: number,
  run: (operator: Operator, services: ChatServices) => Promise<unknown>,
) {
  const requestId = randomUUID();
  let services: ChatServices | undefined;
  let response: Response;
  const errorResponse = (error: AppError) => {
    const mapped = mapAppError(error, requestId);
    return Response.json(mapped.body, { status: mapped.status, headers: mapped.headers });
  };

  try {
    const operator = await authorize();
    services = createChatServices();
    if (operator instanceof Response) {
      const { error } = await operator.json();
      const code = AppErrorCodeSchema.parse(error);
      response = errorResponse(new AppError(code));
      for (const cookie of operator.headers.getSetCookie()) response.headers.append('set-cookie', cookie);
    } else {
      const blocked = assertSameOrigin(request);
      if (blocked) throw new AppError('forbidden_origin');

      const limited = await enforceAdminUserRateLimit(operator.user.id, rateKey, rateLimit);
      if (limited) throw new AppError('rate_limited', { retryAfterSeconds: 60 });

      const result = await run(operator, services);
      response = Response.json(result, { headers: { 'cache-control': CACHE_CONTROL } });
    }
  } catch (error) {
    if (isAppError(error)) {
      response = errorResponse(error);
      if (error.code === 'unauthorized' || error.code === 'account_disabled') withClearedSession(response);
    } else if (error instanceof ChatTransactionBudgetExceeded || isDatabaseUnavailable(error)) {
      response = errorResponse(new AppError('service_unavailable'));
    } else {
      const mapped = mapUnknownFailure(error, requestId);
      response = Response.json(mapped.body, { status: mapped.status, headers: mapped.headers });
    }
  }

  await services?.apiCounter.recordFinalResponse({ routeId, status: response.status, body: null });
  return response;
}
