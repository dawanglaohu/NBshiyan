import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { APIRequestContext } from '@playwright/test';
import { authenticator } from 'otplib';
import { z } from 'zod';
import { AccountDTOSchema, type AccountDTO } from '../src/lib/contracts/account';

export const RUN_AUTH_TOTP = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const SEED_PASSWORD = 'e2e-inq-visual-Passw0rd!';
export const RUN_AUTH_SLOTS = {
  'content-admin': 'ADMIN', 'imageB': 'ADMIN', 'shell-main': 'ADMIN',
  'shell-signout': 'ADMIN', 'shell-cleared': 'ADMIN', editor: 'EDITOR', sales: 'SALES',
} as const;
export type RunAuthSlot = keyof typeof RUN_AUTH_SLOTS;
type State = Awaited<ReturnType<APIRequestContext['storageState']>>;
type RequestFactory = { newContext: (options: { baseURL: string; storageState?: State }) => Promise<APIRequestContext> };
type Environment = Record<string, string | undefined>;
const PREFIX = 'nbshiyan-run-auth-';
const cookieSchema = z.object({
  name: z.enum(['authjs.session-token', '__Secure-authjs.session-token']), value: z.string().min(1).max(16384),
  domain: z.literal('localhost'), path: z.literal('/'), expires: z.number().finite(),
  httpOnly: z.literal(true), secure: z.boolean(), sameSite: z.literal('Lax'),
}).strict();
const stateSchema = z.object({ cookies: z.array(cookieSchema).length(1), origins: z.array(z.never()).length(0) }).strict();
const slotSchema = z.object({ role: z.enum(['ADMIN', 'EDITOR', 'SALES']), user: z.string().min(1), device: z.string().min(1), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const entriesSchema = z.object({
  'content-admin': slotSchema, imageB: slotSchema, 'shell-main': slotSchema,
  'shell-signout': slotSchema, 'shell-cleared': slotSchema, editor: slotSchema, sales: slotSchema,
}).strict();
const manifestSchema = z.object({
  version: z.literal(1), status: z.literal('complete'), nonce: z.string().regex(/^[a-f0-9]{32}$/),
  origin: z.string(), source: z.string().regex(/^[a-f0-9]{40}$/), slots: entriesSchema,
}).strict();
type Manifest = z.infer<typeof manifestSchema>;
export type RunAuthHandle = { directory: string; parent: string; nonce: string; origin: string; source: string; manifestDigest: string };
export type PermissionPolicy = { secure: (target: string, directory: boolean) => void; check: (target: string, directory: boolean) => void };

/** Errors contain a controlled category only, never filesystem, HTTP or credential details. */
export type WindowsPermissionCategory = 'timeout' | 'spawn' | 'nonzero' | 'output' | 'unknown';
export type WindowsPermissionStderr = 'private_owner' | 'private_rules' | 'private_access' | 'other' | 'unknown';
export type WindowsPermissionDiagnostic = { category: WindowsPermissionCategory; stderr: WindowsPermissionStderr };

export class RunAuthError extends Error {
  constructor(readonly code: string, readonly diagnostic?: WindowsPermissionDiagnostic) { super(`E2E_RUN_AUTH_${code}`); this.name = 'RunAuthError'; }
}
function fail(code: string, diagnostic?: WindowsPermissionDiagnostic): never { throw new RunAuthError(code, diagnostic); }
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const fileFor = (slot: RunAuthSlot) => `state-${slot}.json`;
const marker = (handle: RunAuthHandle) => JSON.stringify({ nonce: handle.nonce, origin: handle.origin, source: handle.source });
const sourceOf = (env: Environment) => env.GITHUB_SHA || execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const beneath = (target: string, root: string) => { const rel = path.relative(root, target); return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`)); };

type PermissionExec = (file: string, args: string[], options: {
  encoding: 'utf8'; timeout: number; windowsHide: boolean; env: NodeJS.ProcessEnv; stdio: ['ignore', 'pipe', 'pipe'];
}) => string | Buffer;

const SPAWN_CODES = new Set(['ENOENT', 'EACCES', 'EPERM']);

function stderrCategory(stderr: string): WindowsPermissionStderr {
  if (stderr.includes('private owner')) return 'private_owner';
  if (stderr.includes('private rules')) return 'private_rules';
  if (stderr.includes('private access')) return 'private_access';
  return stderr ? 'other' : 'unknown';
}

function safeText(value: unknown): string | null { return typeof value === 'string' ? value : null; }

/** Classify only fields that are structurally known; raw message/stderr/script/path never leave this function. */
export function classifyWindowsPermissionFailure(error: unknown): WindowsPermissionDiagnostic {
  try {
    if (!error || typeof error !== 'object') return { category: 'unknown', stderr: 'unknown' };
    const record = error as Record<string, unknown>;
    const code = safeText(record.code);
    const status = typeof record.status === 'number' && Number.isInteger(record.status) && record.status >= 0 && record.status <= 255
      ? record.status : null;
    const stderr = stderrCategory(safeText(record.stderr) ?? '');
    if (code === 'ETIMEDOUT') return { category: 'timeout', stderr };
    if (status !== null && status !== 0) return { category: 'nonzero', stderr };
    if (code !== null && SPAWN_CODES.has(code)) return { category: 'spawn', stderr };
    return { category: 'unknown', stderr };
  } catch {
    return { category: 'unknown', stderr: 'unknown' };
  }
}

export function windowsPermission(target: string, directory: boolean, secure: boolean,
                                  exec: PermissionExec = (file, args, options) => execFileSync(file, args, options)) {
  // Set and then inspect the actual NTFS owner/ACL; chmod on Windows cannot prove privacy.
  const script = `$ErrorActionPreference='Stop'; $p=$env:E2E_RUN_AUTH_ACL_PATH; $dir=$env:E2E_RUN_AUTH_ACL_DIR -eq '1'; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $system=[Security.Principal.SecurityIdentifier]::new('S-1-5-18');
if($env:E2E_RUN_AUTH_ACL_SECURE -eq '1') { $acl=if($dir){[Security.AccessControl.DirectorySecurity]::new()}else{[Security.AccessControl.FileSecurity]::new()}; $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); $inherit=if($dir){[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'}else{[Security.AccessControl.InheritanceFlags]::None}; foreach($id in @($sid,$system)){$rule=[Security.AccessControl.FileSystemAccessRule]::new($id,[Security.AccessControl.FileSystemRights]::FullControl,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow);$acl.AddAccessRule($rule)}; Set-Acl -LiteralPath $p -AclObject $acl }
$actual=Get-Acl -LiteralPath $p; if(!$actual.AreAccessRulesProtected -or $actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){throw 'private owner'}; $rules=@($actual.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])); if($rules.Count -ne 2){throw 'private rules'}; foreach($r in $rules){if($r.IdentityReference.Value -notin @($sid.Value,$system.Value) -or $r.AccessControlType -ne 'Allow' -or $r.FileSystemRights -ne 'FullControl' -or $r.IsInherited){throw 'private access'}}; 'PRIVATE_OK'`;
  try {
    const result = exec(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', timeout: 15_000, windowsHide: true,
      env: { ...process.env, E2E_RUN_AUTH_ACL_PATH: target, E2E_RUN_AUTH_ACL_DIR: directory ? '1' : '0', E2E_RUN_AUTH_ACL_SECURE: secure ? '1' : '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (String(result).trim() !== 'PRIVATE_OK') fail('PERMISSIONS', { category: 'output', stderr: 'unknown' });
  } catch (error) {
    if (error instanceof RunAuthError) throw error;
    let diagnostic: WindowsPermissionDiagnostic = { category: 'unknown', stderr: 'unknown' };
    try { diagnostic = classifyWindowsPermissionFailure(error); } catch { /* keep the closed default */ }
    fail('PERMISSIONS', diagnostic);
  }
}
export const privatePermissions: PermissionPolicy = {
  secure(target, directory) {
    if (process.platform === 'win32') { windowsPermission(target, directory, true); return; }
    chmodSync(target, directory ? 0o700 : 0o600);
    this.check(target, directory);
  },
  check(target, directory) {
    const info = lstatSync(target);
    if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) || (!directory && info.nlink !== 1)) fail('SYMLINK_OR_TYPE');
    if (process.platform === 'win32') windowsPermission(target, directory, false);
    else if ((info.mode & 0o777) !== (directory ? 0o700 : 0o600) || info.uid !== process.getuid?.()) fail('PERMISSIONS');
  },
};

function validateHandle(handle: RunAuthHandle) {
  if (!path.isAbsolute(handle.directory) || !path.isAbsolute(handle.parent) || handle.parent !== realpathSync(tmpdir()) || path.dirname(handle.directory) !== handle.parent || !path.basename(handle.directory).startsWith(PREFIX)) fail('DIRECTORY');
  if (!/^[a-f0-9]{32}$/.test(handle.nonce) || !/^[a-f0-9]{40}$/.test(handle.source) || !/^http:\/\/localhost:\d+$/.test(handle.origin)) fail('PROVENANCE');
  if (realpathSync(handle.directory) !== handle.directory || lstatSync(handle.directory).isSymbolicLink()) fail('SYMLINK_OR_TYPE');
}
function readPrivate(handle: RunAuthHandle, name: string, permissions: PermissionPolicy): Buffer {
  validateHandle(handle); permissions.check(handle.directory, true);
  const target = path.join(handle.directory, name);
  permissions.check(target, false);
  const seen = lstatSync(target);
  const fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== seen.dev || opened.ino !== seen.ino || opened.size > 128_000) fail('FILE_CHANGED');
    return readFileSync(fd);
  } finally { closeSync(fd); }
}
function writePrivate(handle: RunAuthHandle, name: string, body: string, permissions: PermissionPolicy) {
  validateHandle(handle); permissions.check(handle.directory, true);
  const target = path.join(handle.directory, name);
  const fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    permissions.secure(target, false);
    if (fstatSync(fd).ino !== lstatSync(target).ino) fail('FILE_CHANGED');
    writeFileSync(fd, body, { encoding: 'utf8' });
  } finally { closeSync(fd); }
}

/** Delete only this invocation's verified directory and known files; unknown content prevents cleanup. */
export function cleanupRunAuth(handle: RunAuthHandle, permissions = privatePermissions) {
  try {
    validateHandle(handle); permissions.check(handle.directory, true);
    if (readPrivate(handle, 'owner.json', permissions).toString() !== marker(handle)) fail('CLEANUP_OWNER');
    const allowed = new Set(['owner.json', 'manifest.json', 'manifest.pending', ...Object.keys(RUN_AUTH_SLOTS).map((slot) => fileFor(slot as RunAuthSlot))]);
    for (const name of readdirSync(handle.directory)) {
      const info = lstatSync(path.join(handle.directory, name));
      if (!allowed.has(name) || !info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail('CLEANUP_CONTENT');
    }
    // The full absolute target and its invocation owner were checked immediately above.
    rmSync(handle.directory, { recursive: true, force: false });
  } catch (error) { if (error instanceof RunAuthError) throw error; fail('CLEANUP'); }
}

export async function createRunAuthPool(options: {
  origin: string; source: string; initialize: (slot: RunAuthSlot, nonce: string) => Promise<{ state: State; account: AccountDTO }>;
  parent?: string; excludedRoots?: string[]; permissions?: PermissionPolicy;
}): Promise<RunAuthHandle> {
  const permissions = options.permissions || privatePermissions;
  let parent: string, directory: string;
  try {
    parent = realpathSync(options.parent || tmpdir());
    if (parent !== realpathSync(tmpdir())) fail('DIRECTORY');
    directory = mkdtempSync(path.join(parent, PREFIX));
  } catch (error) { if (error instanceof RunAuthError) throw error; return fail('DIRECTORY'); }
  const inode = statSync(directory);
  const handle: RunAuthHandle = { directory, parent, nonce: randomBytes(16).toString('hex'), origin: options.origin, source: options.source, manifestDigest: '' };
  let owned = false;
  try {
    validateHandle(handle);
    if ((options.excludedRoots || [process.cwd()]).some((root) => beneath(directory, path.resolve(root)))) fail('ARTIFACT_DIRECTORY');
    permissions.secure(directory, true);
    writePrivate(handle, 'owner.json', marker(handle), permissions); owned = true;
    const slots = {} as Manifest['slots'];
    const users = new Set<string>(), devices = new Set<string>();
    for (const slot of Object.keys(RUN_AUTH_SLOTS) as RunAuthSlot[]) {
      const initialized = await options.initialize(slot, handle.nonce);
      const account = AccountDTOSchema.parse(initialized.account);
      if (account.role !== RUN_AUTH_SLOTS[slot] || !account.totpEnabled || !account.currentDevice.current || account.currentDevice.revokedAt || users.has(account.id) || devices.has(account.currentDevice.id)) fail('IDENTITY');
      users.add(account.id); devices.add(account.currentDevice.id);
      const state = stateSchema.parse({ cookies: initialized.state.cookies.filter((cookie) => /^(?:__Secure-)?authjs\.session-token$/.test(cookie.name)), origins: [] });
      const body = JSON.stringify(state);
      writePrivate(handle, fileFor(slot), body, permissions);
      slots[slot] = { role: account.role, user: account.id, device: account.currentDevice.id, digest: sha(body) };
    }
    const body = JSON.stringify(manifestSchema.parse({ version: 1, status: 'complete', nonce: handle.nonce, origin: handle.origin, source: handle.source, slots }));
    writePrivate(handle, 'manifest.pending', body, permissions);
    renameSync(path.join(directory, 'manifest.pending'), path.join(directory, 'manifest.json'));
    permissions.check(path.join(directory, 'manifest.json'), false);
    handle.manifestDigest = sha(body);
    return handle;
  } catch (error) {
    try {
      if (owned) cleanupRunAuth(handle, permissions);
      else if (path.isAbsolute(directory) && path.dirname(directory) === parent && path.basename(directory).startsWith(PREFIX) && lstatSync(directory).ino === inode.ino && readdirSync(directory).length === 0) rmdirSync(directory);
    } catch { fail(`${error instanceof RunAuthError ? error.code : 'INITIALIZE'}_AND_CLEANUP`); }
    if (error instanceof RunAuthError) throw error;
    return fail('INITIALIZE');
  }
}

export function publishRunAuth(handle: RunAuthHandle, env: Environment = process.env) {
  env.E2E_RUN_AUTH_DIRECTORY = handle.directory; env.E2E_RUN_AUTH_NONCE = handle.nonce;
  env.E2E_RUN_AUTH_SOURCE = handle.source; env.E2E_RUN_AUTH_DIGEST = handle.manifestDigest;
}
export function readRunAuth(slot: RunAuthSlot, origin: string, env: Environment = process.env, permissions = privatePermissions) {
  try {
    if (!(slot in RUN_AUTH_SLOTS) || !env.E2E_RUN_AUTH_DIRECTORY) fail('UNINITIALIZED');
    const handle: RunAuthHandle = { directory: env.E2E_RUN_AUTH_DIRECTORY, parent: realpathSync(tmpdir()), nonce: env.E2E_RUN_AUTH_NONCE || '', source: env.E2E_RUN_AUTH_SOURCE || '', origin, manifestDigest: env.E2E_RUN_AUTH_DIGEST || '' };
    if (handle.source !== sourceOf(env)) fail('SOURCE');
    if (readPrivate(handle, 'owner.json', permissions).toString() !== marker(handle)) fail('PROVENANCE');
    const body = readPrivate(handle, 'manifest.json', permissions);
    if (sha(body) !== handle.manifestDigest) fail('MANIFEST_DIGEST');
    const manifest = manifestSchema.parse(JSON.parse(body.toString()));
    if (manifest.nonce !== handle.nonce || manifest.origin !== origin || manifest.source !== handle.source) fail('PROVENANCE');
    const entry = manifest.slots[slot];
    if (entry.role !== RUN_AUTH_SLOTS[slot]) fail('IDENTITY');
    const stateBytes = readPrivate(handle, fileFor(slot), permissions);
    if (sha(stateBytes) !== entry.digest) fail('STATE_DIGEST');
    const state = stateSchema.parse(JSON.parse(stateBytes.toString()));
    if (state.cookies.some((cookie) => cookie.expires !== -1 && cookie.expires <= Date.now() / 1000)) fail('EXPIRED');
    return { state: state as State, identity: { role: entry.role, user: entry.user, device: entry.device } };
  } catch (error) { if (error instanceof RunAuthError) throw error; fail('CACHE'); }
}

/** Validate the persisted real session using the original account API; no failure reauthenticates. */
export async function loadRunAuth(slot: RunAuthSlot, origin: string, factory: RequestFactory, env: Environment = process.env, permissions = privatePermissions) {
  const cached = readRunAuth(slot, origin, env, permissions);
  let req: APIRequestContext;
  try { req = await factory.newContext({ baseURL: origin, storageState: cached.state }); }
  catch { return fail('REQUEST_CONTEXT'); }
  try {
    const response = await req.get('/api/admin/account');
    if (response.status() !== 200) fail([401, 403, 503].includes(response.status()) ? `SESSION_${response.status()}` : 'SESSION_HTTP');
    const account = AccountDTOSchema.parse(await response.json());
    if (account.role !== cached.identity.role || account.id !== cached.identity.user || account.currentDevice.id !== cached.identity.device || !account.currentDevice.current || account.currentDevice.revokedAt || !account.totpEnabled) fail('IDENTITY');
    return cached.state;
  } catch (error) { if (error instanceof RunAuthError) throw error; fail('SESSION'); }
  finally { try { await req.dispose(); } catch { fail('REQUEST_CLEANUP'); } }
}

/** Called once by globalSetup after the existing webServer plugin has completed readiness. */
export async function initializeRunAuth(origin: string, factory: RequestFactory, env: Environment = process.env) {
  if (env.E2E_RUN_AUTH_DIRECTORY) fail('ALREADY_INITIALIZED');
  let source: string;
  try { source = sourceOf(env); } catch { return fail('SOURCE'); }
  const handle = await createRunAuthPool({ origin, source, initialize: async (slot, nonce) => {
    const email = `run-auth-${slot}-${nonce}@example.test`.toLowerCase();
    execFileSync('node', ['scripts/create-admin.mjs'], { stdio: 'ignore', env: { ...process.env, ADMIN_SEED_EMAIL: email, ADMIN_SEED_PASSWORD: SEED_PASSWORD, ADMIN_SEED_NAME: `E2E ${slot}`, ADMIN_SEED_ROLE: RUN_AUTH_SLOTS[slot], ADMIN_SEED_TOTP_SECRET: RUN_AUTH_TOTP } });
    const req = await factory.newContext({ baseURL: origin });
    try {
      const csrfResponse = await req.get('/api/auth/csrf');
      const csrfStatus = csrfResponse.status();
      if (csrfStatus !== 200) {
        const mode = env.SMTP_EVIDENCE_MODE;
        if (mode && ['http-real', 'http-disabled', 'off'].includes(mode)) {
          const requestedOrigin = ['http://localhost:3100', 'http://127.0.0.1:3100'].includes(origin) ? origin : null;
          try {
            console.error(JSON.stringify({ type: 'run-auth-csrf', category: 'CSRF_HTTP_STATUS',
              slot: Object.hasOwn(RUN_AUTH_SLOTS, slot) ? slot : null, mode, method: 'GET', origin: requestedOrigin,
              path: '/api/auth/csrf', status: Number.isInteger(csrfStatus) && csrfStatus >= 100 && csrfStatus <= 599 ? csrfStatus : null }));
          } catch { /* Diagnostic output must not replace the original authentication failure. */ }
        }
        fail('CSRF');
      }
      const csrfToken = (await csrfResponse.json()).csrfToken;
      if (typeof csrfToken !== 'string' || !csrfToken) fail('CSRF');
      const login = await req.post('/api/auth/callback/credentials', { maxRedirects: 0, headers: { Origin: origin }, form: { csrfToken, email, password: SEED_PASSWORD, totp: authenticator.generate(RUN_AUTH_TOTP) } });
      if (login.status() !== 302 || !login.headers().location || new URL(login.headers().location, origin).searchParams.has('error')) fail('LOGIN');
      const response = await req.get('/api/admin/account');
      if (response.status() !== 200) fail('SESSION_HTTP');
      const account = AccountDTOSchema.parse(await response.json());
      if (account.email !== email) fail('IDENTITY');
      return { state: await req.storageState(), account };
    } finally { await req.dispose(); }
  } });
  publishRunAuth(handle, env);
  return () => {
    cleanupRunAuth(handle);
    if (env.E2E_RUN_AUTH_NONCE === handle.nonce) for (const key of ['E2E_RUN_AUTH_DIRECTORY', 'E2E_RUN_AUTH_NONCE', 'E2E_RUN_AUTH_SOURCE', 'E2E_RUN_AUTH_DIGEST']) delete env[key];
  };
}
