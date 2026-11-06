import { test, expect } from './fixtures';
import { loadRunAuth, RUN_AUTH_TOTP, type RunAuthSlot } from './run-auth';
import type { APIRequestContext } from '@playwright/test';

export const E2E_TOTP = RUN_AUTH_TOTP;
const BASE = `http://localhost:${Number(process.env.E2E_PORT ?? 3100)}`;

/** Each group reads its assigned run-owned real session. Restarted workers never seed or log in. */
export function useSharedAdmin(o: { emailPrefix: string; name: string; probe: string; slot: RunAuthSlot }) {
  let state: Awaited<ReturnType<APIRequestContext['storageState']>>;
  test.beforeAll(async ({ playwright }) => {
    state = await loadRunAuth(o.slot, BASE, playwright.request);
    const request = await playwright.request.newContext({ baseURL: BASE, storageState: state });
    try { expect((await request.get(o.probe)).status()).toBe(200); }
    finally { await request.dispose(); }
  });
  test.beforeEach(async ({ page }) => { await page.context().addCookies(state.cookies); });
}
