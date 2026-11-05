'use client';

import { requestApi, type ClientApiResult } from './api';
import {
  AccountDTOSchema,
  SessionActivityDTOSchema,
  type AccountDTO,
  type SessionActivityDTO,
} from '@/lib/contracts/account';

/**
 * 后台账号的客户端请求基础（M3-T7）。
 *
 * 这是本卡首先要落地的唯一请求入口：后继任务（M3-T12 个人安全表单等）只在这里追加方法，
 * 不重造 fetch / 重试 / 错误适配。`requestApi` 已负责同源、15s 截止、错误信封与 401 语义，
 * 这里不再包一层自己的 transport。
 */

export type AccountResult = ClientApiResult<AccountDTO>;
export type SessionActivityResult = ClientApiResult<SessionActivityDTO>;

/**
 * 读取当前账号：GET /api/admin/account。
 *
 * 角色、当前设备、有效期都来自服务端会话，不由客户端推断。401 时 `requestApi` 会把
 * `audience:'admin'` 映射成 `action:'login'`，调用方据此清内容、取消在途并去登录页。
 */
export function getAccount(options: { signal?: AbortSignal; locale?: 'en' | 'ru' } = {}): Promise<AccountResult> {
  return requestApi({
    path: '/api/admin/account',
    method: 'GET',
    schema: AccountDTOSchema,
    audience: 'admin',
    signal: options.signal,
    locale: options.locale,
  });
}

/**
 * 上报真实活动：POST /api/admin/account/session/activity。
 *
 * 只在可见页发生真实鼠标/键盘/路由操作后调用；轮询、隐藏页、无参 session 读取都不调用。
 * 15 分钟节流与「同一时刻只有一个在途」由 AdminSessionActivity 负责，这里如实发一次请求，
 * 不重试、不缓存。`SessionActivityRequestSchema` 是 `{}`，body 固定空对象。
 */
export function postSessionActivity(options: { signal?: AbortSignal; locale?: 'en' | 'ru' } = {}): Promise<SessionActivityResult> {
  return requestApi({
    path: '/api/admin/account/session/activity',
    method: 'POST',
    body: {},
    schema: SessionActivityDTOSchema,
    audience: 'admin',
    signal: options.signal,
    locale: options.locale,
  });
}
