import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { chmodSync, lstatSync, readFileSync, readdirSync, writeFileSync, symlinkSync, unlinkSync, realpathSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { APIRequestContext } from '@playwright/test';
import { AccountDTOSchema, type AccountDTO } from '../src/lib/contracts/account';
import { createRunAuthPool, cleanupRunAuth, publishRunAuth, readRunAuth, loadRunAuth, initializeRunAuth, RUN_AUTH_SLOTS, RunAuthError, privatePermissions, type PermissionPolicy, type RunAuthSlot } from '../e2e/run-auth';
import { MemoryStore } from '../src/lib/server/ratelimit';

const ORIGIN = 'http://localhost:3100';
const SOURCE = 'a'.repeat(40);
const permissions: PermissionPolicy = {
  secure(target, directory) { if (process.platform !== 'win32') chmodSync(target, directory ? 0o700 : 0o600); this.check(target, directory); },
  check(target, directory) { const s = lstatSync(target); if (s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile())) throw new Error('test permission boundary'); },
};
function member(slot: RunAuthSlot, value = slot) {
  const account = AccountDTOSchema.parse({
    id: `user-${value}`, name: `E2E ${slot}`, email: `test-${value}@example.test`, role: RUN_AUTH_SLOTS[slot], passwordlessEnabled: false, totpEnabled: true,
    currentDevice: { id: `device-${value}`, current: true, remembered: false, createdAt: '2026-01-01T00:00:00.000Z', lastActivityAt: '2026-01-01T00:00:00.000Z', effectiveExpiresAt: '2099-01-01T00:00:00.000Z', absoluteExpiresAt: null, revokedAt: null, deviceLabel: null },
  });
  const state: Awaited<ReturnType<APIRequestContext['storageState']>> = { cookies: [{ name: '__Secure-authjs.session-token', value: `synthetic-unit-only-${value}`, domain: 'localhost', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }], origins: [] };
  return { account, state };
}
async function pool(policy = permissions) {
  let initialized = 0;
  const handle = await createRunAuthPool({ origin: ORIGIN, source: SOURCE, permissions: policy, initialize: async (slot) => { initialized++; return member(slot); } });
  const env = { GITHUB_SHA: SOURCE } as Record<string, string | undefined>;
  publishRunAuth(handle, env);
  return { handle, env, initialized: () => initialized };
}
const requestFactory = (account: AccountDTO, status = 200) => {
  let opened = 0, disposed = 0;
  const factory = { newContext: async () => {
    opened++;
    return { get: async () => ({ status: () => status, json: async () => account }), dispose: async () => { disposed++; } } as unknown as APIRequestContext;
  } };
  return { factory, opened: () => opened, disposed: () => disposed };
};

test('run-auth publishes all seven distinct duties once; three replacement workers only read', async () => {
  const p = await pool();
  try {
    const identities = new Set<string>(), devices = new Set<string>();
    for (const slot of Object.keys(RUN_AUTH_SLOTS) as RunAuthSlot[]) {
      const value = readRunAuth(slot, ORIGIN, p.env, permissions);
      assert.equal(value.identity.role, RUN_AUTH_SLOTS[slot]); identities.add(value.identity.user); devices.add(value.identity.device);
    }
    assert.equal(identities.size, 7); assert.equal(devices.size, 7);
    for (let worker = 0; worker < 3; worker++) assert.equal(readRunAuth('content-admin', ORIGIN, { ...p.env }, permissions).identity.user, 'user-content-admin');
    assert.equal(p.initialized(), 7);
    assert.equal(readdirSync(p.handle.directory).length, 9);
    assert.equal(path.dirname(p.handle.directory), realpathSync(tmpdir()));
    assert.ok(!p.handle.directory.startsWith(realpathSync('.') + path.sep));
  } finally { cleanupRunAuth(p.handle, permissions); }
});

test('run-auth rejects old invocation, origin/source mismatch, incomplete/invalid JSON and wrong identities without initialization', async () => {
  const p = await pool();
  try {
    assert.throws(() => readRunAuth('sales', ORIGIN, { ...p.env, E2E_RUN_AUTH_NONCE: 'f'.repeat(32) }, permissions));
    assert.throws(() => readRunAuth('sales', 'http://localhost:3101', p.env, permissions));
    assert.throws(() => readRunAuth('sales', ORIGIN, { ...p.env, GITHUB_SHA: 'b'.repeat(40) }, permissions));
    const manifestPath = path.join(p.handle.directory, 'manifest.json');
    const original = readFileSync(manifestPath);
    for (const mutation of ['{bad-json', JSON.stringify({ status: 'pending' }), ...['role', 'user', 'device'].map((key) => {
      const m = JSON.parse(original.toString()); m.slots.sales[key] = key === 'role' ? 'ADMIN' : 'wrong'; return JSON.stringify(m);
    })]) {
      writeFileSync(manifestPath, mutation);
      assert.throws(() => readRunAuth('sales', ORIGIN, p.env, permissions));
    }
    writeFileSync(manifestPath, original);
    const statePath = path.join(p.handle.directory, 'state-sales.json');
    const state = readFileSync(statePath); writeFileSync(statePath, '{}');
    assert.throws(() => readRunAuth('sales', ORIGIN, p.env, permissions)); writeFileSync(statePath, state);
    assert.equal(p.initialized(), 7);
    const other = await pool();
    try { assert.throws(() => readRunAuth('sales', ORIGIN, { ...other.env, E2E_RUN_AUTH_DIRECTORY: p.handle.directory }, permissions)); }
    finally { cleanupRunAuth(other.handle, permissions); }
  } finally { cleanupRunAuth(p.handle, permissions); }
});

test('run-auth session 401/403/503 and live user/device/role changes never perform credentials login', async () => {
  const p = await pool();
  try {
    const entry = readRunAuth('content-admin', ORIGIN, p.env, permissions);
    // The unit transport contains no login endpoint. Production still uses real Auth.js and GET account.
    for (const status of [401, 403, 503]) {
      const f = requestFactory(member('content-admin').account, status);
      await assert.rejects(() => loadRunAuth('content-admin', ORIGIN, f.factory, p.env, permissions), new RegExp(`SESSION_${status}`));
      assert.equal(f.opened(), 1); assert.equal(f.disposed(), 1);
    }
    for (const field of ['id', 'role', 'device']) {
      const account = member('content-admin').account;
      if (field === 'id') account.id = 'other-user';
      else if (field === 'role') account.role = 'SALES';
      else account.currentDevice.id = 'other-device';
      await assert.rejects(() => loadRunAuth('content-admin', ORIGIN, requestFactory(account).factory, p.env, permissions), /IDENTITY/);
    }
    const good = requestFactory(member('content-admin').account);
    assert.deepEqual(await loadRunAuth('content-admin', ORIGIN, good.factory, p.env, permissions), entry.state);
    assert.equal(p.initialized(), 7);
  } finally { cleanupRunAuth(p.handle, permissions); }
});

test('run-auth fourth initialization failure never publishes a complete manifest', async () => {
  let directory: string | undefined;
  let calls = 0;
  const policy: PermissionPolicy = { secure(target, dir) { if (dir) directory = target; permissions.secure(target, dir); }, check: permissions.check };
  await assert.rejects(() => createRunAuthPool({ origin: ORIGIN, source: SOURCE, permissions: policy, initialize: async (slot) => {
    if (++calls === 4) throw new Error('synthetic failure'); return member(slot);
  } }), /INITIALIZE/);
  assert.equal(calls, 4); assert.ok(directory);
  assert.throws(() => lstatSync(directory!));
});

test('run-auth refuses failed privacy and symlinks and preserves unknown user content during cleanup', async () => {
  let initialized = 0;
  await assert.rejects(() => createRunAuthPool({ origin: ORIGIN, source: SOURCE, permissions: { secure() { throw new Error('permission denied'); }, check() { throw new Error('permission denied'); } }, initialize: async (slot) => { initialized++; return member(slot); } }), /INITIALIZE/);
  assert.equal(initialized, 0);
  const p = await pool();
  try {
    const sentinel = path.join(p.handle.directory, 'user-document.txt'); writeFileSync(sentinel, 'preserve');
    assert.throws(() => cleanupRunAuth(p.handle, permissions)); assert.equal(readFileSync(sentinel, 'utf8'), 'preserve');
    unlinkSync(sentinel);
    // The junction points at this test-owned directory; it never touches or deletes an unrelated target.
    const link = path.join(p.handle.directory, 'link'); symlinkSync(p.handle.directory, link, process.platform === 'win32' ? 'junction' : 'dir');
    try { assert.throws(() => readRunAuth('sales', ORIGIN, { ...p.env, E2E_RUN_AUTH_DIRECTORY: link }, permissions)); }
    finally { unlinkSync(link); }
    assert.throws(() => readRunAuth('sales', ORIGIN, p.env, { secure() {}, check() { throw new Error('private mode lost'); } }));
  } finally { cleanupRunAuth(p.handle, permissions); }
});

test('run-auth real platform directory/file permissions are restricted before writing session state', async () => {
  const p = await pool(privatePermissions);
  try {
    privatePermissions.check(p.handle.directory, true);
    privatePermissions.check(path.join(p.handle.directory, 'state-content-admin.json'), false);
    assert.equal(readRunAuth('content-admin', ORIGIN, p.env).identity.role, 'ADMIN');
    if (process.platform !== 'win32') {
      chmodSync(path.join(p.handle.directory, 'state-content-admin.json'), 0o644);
      assert.throws(() => readRunAuth('content-admin', ORIGIN, p.env), /PERMISSIONS/);
      chmodSync(path.join(p.handle.directory, 'state-content-admin.json'), 0o600);
    }
  } finally { cleanupRunAuth(p.handle); }
});

test('run-auth consumer slots never authenticate in workers and keep quota/activity/lifecycle identities separate', () => {
  const consumers = ['shared-admin.ts', 'admin-about-images.spec.ts', 'admin-org-settings.spec.ts', 'admin-shell-activity.spec.ts', 'brand-smoke.spec.ts', 'admin-legacy-inquiries-visual.spec.ts', 'admin-legacy-model-visual.spec.ts', 'admin-legacy-specs-visual.spec.ts'];
  for (const consumer of consumers) assert.doesNotMatch(readFileSync(`e2e/${consumer}`, 'utf8'), /\.post\(['"][^'"]*callback\/credentials|execFileSync\(|authenticator\.generate\(/, consumer);
  assert.match(readFileSync('e2e/admin-about-images.spec.ts', 'utf8'), /tag === 'a' \? 'content-admin' : 'imageB'/);
  const shell = readFileSync('e2e/admin-shell-activity.spec.ts', 'utf8');
  for (const slot of ['shell-main', 'shell-signout', 'shell-cleared']) assert.match(shell, new RegExp(`slot: '${slot}'`));
  assert.match(readFileSync('e2e/brand-smoke.spec.ts', 'utf8'), /loadRunAuth\('content-admin'/);
  assert.match(readFileSync('e2e/admin-legacy-inquiries-visual.spec.ts', 'utf8'), /role === 'ADMIN' \? 'content-admin' : 'sales'/);
  const model = readFileSync('e2e/admin-legacy-model-visual.spec.ts', 'utf8');
  const modelReader = (source: string) => {
    assert.doesNotMatch(source, /callback\/credentials|execFileSync\(|authenticator\.generate\(/);
    assert.match(source, /state = await loadRunAuth\(role === 'ADMIN' \? 'content-admin' : 'editor', BASE, playwright\.request\)/);
  };
  modelReader(model);
  assert.throws(() => modelReader(model + '\nrequest.post("/api/auth/callback/credentials");'));
  assert.throws(() => modelReader(model.replace("'content-admin' : 'editor'", "'content-admin' : 'content-admin'")));
});

test('run-auth specs reader checks each live role and never authenticates after rejection', async () => {
  const source = readFileSync('e2e/admin-legacy-specs-visual.spec.ts', 'utf8');
  const tree = ts.createSourceFile('specs.ts', source, ts.ScriptTarget.Latest, true);
  const declaration = tree.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'readRoleState');
  assert.ok(declaration);
  const mapping = /const ROLE_SLOTS = (\{[^;]+\}) as const;/.exec(source)?.[1];
  assert.ok(mapping);
  const readerGuard = (candidate: string) => {
    assert.doesNotMatch(candidate, /callback\/credentials|execFileSync\(|authenticator\.generate\(/);
    assert.match(candidate, /ADMIN: 'content-admin', EDITOR: 'editor', SALES: 'sales'/);
    assert.match(candidate, /loadRunAuth\(ROLE_SLOTS\[role\], BASE, playwright\.request\)/);
  };
  readerGuard(source);
  assert.throws(() => readerGuard(source + '\nrequest.post("/api/auth/callback/credentials");'));
  assert.throws(() => readerGuard(source.replace("EDITOR: 'editor'", "EDITOR: 'content-admin'")));
  assert.throws(() => readerGuard(source.replace("SALES: 'sales'", "SALES: 'content-admin'")));
  const body = ts.transpileModule(declaration.getText(tree), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  for (const scenario of ['valid', 'wrong-role', 'denied-cache']) {
    let cachedReads = 0, opened = 0, disposed = 0, posts = 0;
    const factory = { newContext: async () => {
      opened++;
      return { get: async (url: string) => {
        assert.equal(url, '/api/admin/account');
        return { status: () => 200, json: async () => ({ role: scenario === 'wrong-role' ? 'ADMIN' : 'EDITOR' }) };
      }, post: async () => { posts++; throw new Error('unexpected credentials'); }, dispose: async () => { disposed++; } } as unknown as APIRequestContext;
    } };
    const state = member('editor').state;
    const reader = runInNewContext(body + '\nreadRoleState;', { BASE: ORIGIN, ROLE_SLOTS: { ADMIN: 'content-admin', EDITOR: 'editor', SALES: 'sales' },
      loadRunAuth: async (slot: string) => { cachedReads++; assert.equal(slot, 'editor'); if (scenario === 'denied-cache') throw new RunAuthError('SESSION_401'); return state; },
    }) as (playwright: { request: typeof factory }, role: 'EDITOR') => Promise<typeof state>;
    if (scenario === 'valid') assert.equal(await reader({ request: factory }, 'EDITOR'), state);
    else await assert.rejects(() => reader({ request: factory }, 'EDITOR'), new RegExp(scenario === 'wrong-role' ? 'E2E_RUN_AUTH_SPEC_ROLE' : 'SESSION_401'));
    assert.equal(cachedReads, 1); assert.equal(opened, scenario === 'denied-cache' ? 0 : 1); assert.equal(disposed, opened); assert.equal(posts, 0);
  }
});

test('run-auth 29 compressed login-IP hits pass; duplicate initialization goes over the original 30 ceiling', async () => {
  const lifecycle = { device: 4, enroll: 11, loginUI: 2, globalAdmin: 4, hotfix: 1 };
  assert.equal(Object.values(lifecycle).reduce((a, b) => a + b, 0), 22);
  const store = new MemoryStore();
  for (let i = 0; i < 29; i++) assert.equal(await store.hit('unit-auth-budget', 30, 600_000), true);
  assert.equal(await store.hit('unit-auth-budget', 30, 600_000), true);
  assert.equal(await store.hit('unit-auth-budget', 30, 600_000), false);
  await assert.rejects(() => initializeRunAuth(ORIGIN, requestFactory(member('content-admin').account).factory, { E2E_RUN_AUTH_DIRECTORY: 'already' }), /ALREADY_INITIALIZED/);
  assert.equal(Object.keys(RUN_AUTH_SLOTS).length + 22, 29);
});

test('run-auth initialization uses one normalized email for seed, credentials and strict account validation', async () => {
  const source = readFileSync('e2e/run-auth.ts', 'utf8');
  const tree = ts.createSourceFile('run-auth.ts', source, ts.ScriptTarget.Latest, true);
  const declaration = tree.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'initializeRunAuth');
  assert.ok(declaration);
  const current = declaration.getText(tree).replace(/^export\s+/, '');
  const legacy = current.replace(/\.toLowerCase\(\)/, '');
  const fail = (code: string): never => { throw new RunAuthError(code); };
  // Execute the actual initializer body with synthetic seed/HTTP transports, not a real authentication claim.
  for (const scenario of ['current', 'legacy-case', 'wrong-account']) {
    const env = { GITHUB_SHA: SOURCE } as Record<string, string | undefined>;
    const seeded: string[] = [], credentials: string[] = [];
    let identity: ReturnType<typeof member>;
    let disposed = 0, directory: string | undefined;
    const policy: PermissionPolicy = { secure(target, dir) { if (dir) directory = target; permissions.secure(target, dir); }, check: permissions.check };
    const factory = { newContext: async () => ({
      get: async (url: string) => {
        if (url === '/api/auth/csrf') return { status: () => 200, json: async () => ({ csrfToken: 'synthetic-csrf' }) };
        assert.equal(url, '/api/admin/account');
        const account = { ...identity.account };
        if (scenario === 'wrong-account' && seeded.length === 2) account.email = 'other@example.test';
        return { status: () => 200, json: async () => account };
      },
      post: async (url: string, options: { form: { email: string } }) => {
        assert.equal(url, '/api/auth/callback/credentials');
        credentials.push(options.form.email);
        assert.equal(options.form.email.trim().toLowerCase(), identity.account.email);
        return { status: () => 302, headers: () => ({ location: '/admin' }) };
      },
      storageState: async () => identity.state,
      dispose: async () => { disposed++; },
    }) as unknown as APIRequestContext };
    const initialize = runInNewContext(ts.transpileModule(scenario === 'legacy-case' ? legacy : current, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText + '\ninitializeRunAuth;', {
      process: { env }, sourceOf: () => SOURCE, fail, RUN_AUTH_SLOTS, AccountDTOSchema, URL,
      authenticator: { generate: () => '123456' }, RUN_AUTH_TOTP: 'synthetic-totp', SEED_PASSWORD: 'synthetic-password',
      execFileSync: (command: string, args: string[], options: { env: Record<string, string> }) => {
        assert.equal(command, 'node'); assert.deepEqual(Array.from(args), ['scripts/create-admin.mjs']);
        const slot = Object.keys(RUN_AUTH_SLOTS)[seeded.length] as RunAuthSlot;
        identity = member(slot); identity.account.email = options.env.ADMIN_SEED_EMAIL.trim().toLowerCase();
        assert.equal(options.env.ADMIN_SEED_ROLE, RUN_AUTH_SLOTS[slot]); seeded.push(options.env.ADMIN_SEED_EMAIL);
      },
      createRunAuthPool: (options: Parameters<typeof createRunAuthPool>[0]) => createRunAuthPool({ ...options, permissions: policy }),
      publishRunAuth, cleanupRunAuth: (handle: Parameters<typeof cleanupRunAuth>[0]) => cleanupRunAuth(handle, policy),
    }) as typeof initializeRunAuth;
    if (scenario === 'current') {
      const teardown = await initialize(ORIGIN, factory, env);
      try {
        assert.equal(seeded.length, 7); assert.equal(new Set(seeded).size, 7);
        assert.deepEqual(credentials, seeded); assert.ok(seeded.every((email) => email === email.toLowerCase()));
        assert.match(seeded[1], /^run-auth-imageb-/);
        assert.equal(readRunAuth('imageB', ORIGIN, env, policy).identity.role, 'ADMIN');
      } finally { teardown(); }
    } else {
      await assert.rejects(() => initialize(ORIGIN, factory, env), /E2E_RUN_AUTH_IDENTITY/);
      assert.equal(seeded.length, 2); assert.equal(env.E2E_RUN_AUTH_DIRECTORY, undefined);
    }
    assert.equal(disposed, seeded.length); assert.ok(directory); assert.throws(() => lstatSync(directory!));
  }
});

test('run-auth runner resolution uses the declared consumer under strict dependency visibility', () => {
  const directory = mkdtempSync(path.join(realpathSync(tmpdir()), 'nbshiyan-run-auth-resolution-'));
  try {
    const consumer = path.join(directory, 'node_modules/@playwright/test');
    const runner = path.join(consumer, 'node_modules/playwright');
    mkdirSync(runner, { recursive: true });
    writeFileSync(path.join(directory, 'package.json'), '{}');
    writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({ name: '@playwright/test', dependencies: { playwright: '1.64.0' } }));
    writeFileSync(path.join(runner, 'package.json'), JSON.stringify({ name: 'playwright', version: '1.64.0' }));
    assert.throws(() => createRequire(path.join(directory, 'package.json')).resolve('playwright/package.json'), { code: 'MODULE_NOT_FOUND' });
    assert.equal(realpathSync(resolveRunnerPackage(path.join(directory, 'package.json'))), realpathSync(path.join(runner, 'package.json')));
  } finally {
    assert.equal(path.dirname(directory), realpathSync(tmpdir()));
    assert.ok(path.basename(directory).startsWith('nbshiyan-run-auth-resolution-'));
    rmSync(directory, { recursive: true, force: false });
  }
});

test('run-auth actual runner orders webServer plugin readiness before globalSetup', () => {
  const runner = readFileSync(path.join(path.dirname(resolveRunnerPackage()), 'lib/runner/index.js'), 'utf8');
  assert.match(runner, /webServerPluginsForConfig\(config2\).*config2\.plugins\.push/s);
  const global = runner.slice(runner.indexOf('function createGlobalSetupTasks('), runner.indexOf('function createRunTestsTasks('));
  assert.ok(global.indexOf('createPluginSetupTasks') < global.indexOf('config2.globalSetups.map'));
  const setup = readFileSync('e2e/global-setup.ts', 'utf8');
  assert.match(setup, /return initializeRunAuth\(/);
  for (const lifecycle of ['admin.spec.ts', 'admin-enroll.spec.ts', 'admin-login.spec.ts', 'admin-device-session.spec.ts', 'hotfix-login-empty.spec.ts']) assert.doesNotMatch(readFileSync(`e2e/${lifecycle}`, 'utf8'), /loadRunAuth|readRunAuth/);
});

test('run-auth CSRF evidence is mail-only, whitelist-only and preserves the actual initializer failure and success paths', async () => {
  const source = readFileSync('e2e/run-auth.ts', 'utf8');
  const tree = ts.createSourceFile('run-auth.ts', source, ts.ScriptTarget.Latest, true);
  const declaration = tree.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'initializeRunAuth');
  assert.ok(declaration);
  const code = ts.transpileModule(declaration.getText(tree).replace(/^export\s+/, ''), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText + '\ninitializeRunAuth;';
  const scenarios = [
    ...['http-real', 'http-disabled', 'off'].flatMap(mode => [400, 401, 403, 404, 429, 500, 503, 0, 700].map(status => ({ mode, status, origin: ORIGIN, slot: 'content-admin', loggerThrows: false }))),
    ...[undefined, 'invalid'].map(mode => ({ mode, status: 503, origin: ORIGIN, slot: 'content-admin', loggerThrows: false })),
    { mode: 'http-real', status: 503, origin: 'https://untrusted.invalid/private', slot: 'unknown', loggerThrows: false },
    { mode: 'http-real', status: 503, origin: 'http://127.0.0.1:3100', slot: 'sales', loggerThrows: false },
    { mode: 'http-real', status: 503, origin: ORIGIN, slot: 'editor', loggerThrows: true },
    ...[undefined, 'http-real', 'http-disabled', 'off'].map(mode => ({ mode, status: 200, origin: ORIGIN, slot: 'content-admin', loggerThrows: false })),
  ];
  for (const scenario of scenarios) {
    const env = { GITHUB_SHA: SOURCE, SMTP_EVIDENCE_MODE: scenario.mode } as Record<string, string | undefined>;
    let csrfGets = 0, csrfReads = 0, logins = 0, disposed = 0, published = 0, cleanups = 0, seededEmail = '';
    const logs: string[] = [];
    const factory = { newContext: async () => ({
      get: async (url: string) => {
        if (url === '/api/auth/csrf') {
          csrfGets++;
          return { status: () => scenario.status, headers: () => { throw new Error('headers must not be read'); }, json: async () => { csrfReads++; return { csrfToken: 'private-token-marker' }; } };
        }
        assert.equal(url, '/api/admin/account');
        return { status: () => 200, json: async () => ({ email: seededEmail }) };
      },
      post: async (url: string) => { assert.equal(url, '/api/auth/callback/credentials'); logins++; return { status: () => 302, headers: () => ({ location: '/admin' }) }; },
      storageState: async () => ({ cookies: [], origins: [] }), dispose: async () => { disposed++; },
    }) as unknown as APIRequestContext };
    const initialize = runInNewContext(code, {
      process: { env }, sourceOf: () => SOURCE, RUN_AUTH_SLOTS, URL,
      fail: (category: string): never => { throw new RunAuthError(category); },
      console: { error: (line: string) => { if (scenario.loggerThrows) throw new Error('private-log-error-marker'); logs.push(line); } },
      execFileSync: (_command: string, _args: string[], options: { env: Record<string, string> }) => { seededEmail = options.env.ADMIN_SEED_EMAIL; },
      createRunAuthPool: async (options: { initialize: (slot: string, nonce: string) => Promise<unknown> }) => { await options.initialize(scenario.slot, 'control'); return {}; },
      publishRunAuth: () => { published++; }, cleanupRunAuth: () => { cleanups++; },
      AccountDTOSchema: { parse: (value: unknown) => value }, authenticator: { generate: () => 'private-totp-marker' }, RUN_AUTH_TOTP: 'private-totp-marker', SEED_PASSWORD: 'private-password-marker',
    }) as typeof initializeRunAuth;
    if (scenario.status === 200) {
      const teardown = await initialize(scenario.origin, factory, env); teardown();
      assert.deepEqual([csrfGets, csrfReads, logins, disposed, published, cleanups], [1, 1, 1, 1, 1, 1]);
      assert.equal(logs.length, 0);
    } else {
      await assert.rejects(() => initialize(scenario.origin, factory, env), /E2E_RUN_AUTH_CSRF/);
      assert.deepEqual([csrfGets, csrfReads, logins, disposed, published], [1, 0, 0, 1, 0]);
      const enabled = !!scenario.mode && ['http-real', 'http-disabled', 'off'].includes(scenario.mode);
      assert.equal(logs.length, enabled && !scenario.loggerThrows ? 1 : 0);
      if (logs.length) {
        const record = JSON.parse(logs[0]);
        assert.deepEqual(record, { type: 'run-auth-csrf', category: 'CSRF_HTTP_STATUS', slot: Object.hasOwn(RUN_AUTH_SLOTS, scenario.slot) ? scenario.slot : null,
          mode: scenario.mode, method: 'GET', origin: [ORIGIN, 'http://127.0.0.1:3100'].includes(scenario.origin) ? scenario.origin : null,
          path: '/api/auth/csrf', status: scenario.status >= 100 && scenario.status <= 599 ? scenario.status : null });
        assert.equal(logs[0].includes('private-'), false);
        assert.equal(logs[0].includes('untrusted.invalid'), false);
      }
    }
  }
});

function resolveRunnerPackage(project = path.resolve('package.json')) {
  const consumer = createRequire(project).resolve('@playwright/test/package.json');
  return createRequire(consumer).resolve('playwright/package.json');
}
