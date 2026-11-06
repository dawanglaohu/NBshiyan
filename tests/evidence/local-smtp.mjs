import assert from 'node:assert/strict';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import tls from 'node:tls';
import { pathToFileURL } from 'node:url';
import nodemailer from 'nodemailer';

// Isolated Linux CI SMTP preflight. Credentials and SMTP payload are never logged.
const HOST = 'smtp.evidence.test';
const PORTS = [465, 587];
const PREFIX = 'nbshiyan-mail-evidence.';
const FILES = new Set(['owner.json', 'private.json', 'lifecycle.json', 'pg.pass', 'driver.sh', 'hosts', 'ca.key.pem', 'ca.cert.pem', 'leaf.key.pem', 'leaf.csr.pem', 'leaf.cert.pem', 'rogue-ca.key.pem', 'rogue-ca.cert.pem', 'rogue-leaf.key.pem', 'rogue-leaf.csr.pem', 'rogue-leaf.cert.pem', 'leaf.ext', 'target.json']);
const CERTIFICATE_CODES = new Set(['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID']);
let preflightReport;
const MAX_COMMAND = 16_384;
const MAX_DATA = 2_097_152;
const MAX_LINE = 65_536;
const mode = process.argv[2];
const args = process.argv.slice(3);
const arg = (name) => { const i = args.indexOf(`--${name}`); return i === -1 ? undefined : args[i + 1]; };
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const safeCode = (error) => /^[A-Z0-9_]{1,60}$/.test(error?.code || '') ? error.code : 'SMTP_EVIDENCE_FAILED';
const same = (a, b) => { const x = Buffer.from(a || ''), y = Buffer.from(b || ''); return x.length === y.length && timingSafeEqual(x, y); };
const writeNew = (file, value) => fs.writeFileSync(file, value, { mode: 0o600, flag: 'wx' });

function rootInfo({ create = false } = {}) {
  if (process.platform !== 'linux' || process.env.CI !== 'true' || process.env.GITHUB_ACTIONS !== 'true') fail('LINUX_CI_REQUIRED');
  const requested = arg('root');
  const parent = fs.realpathSync(process.env.RUNNER_TEMP || os.tmpdir());
  if (!requested || !path.isAbsolute(requested)) fail('PRIVATE_ROOT_REQUIRED');
  const root = fs.realpathSync(requested);
  const stat = fs.lstatSync(requested);
  if (stat.isSymbolicLink() || !stat.isDirectory() || path.dirname(root) !== parent || !path.basename(root).startsWith(PREFIX) || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) fail('PRIVATE_ROOT_REJECTED');
  const marker = path.join(root, 'owner.json');
  if (create) {
    if (fs.readdirSync(root).length) fail('PRIVATE_ROOT_NOT_EMPTY');
    const owner = { version: 1, uid: process.getuid(), nonce: randomBytes(16).toString('hex'), rootInode: stat.ino,
      hostNetNamespace: fs.readlinkSync('/proc/self/ns/net'), hostPidNamespace: fs.readlinkSync('/proc/self/ns/pid') };
    writeNew(marker, JSON.stringify(owner));
    return { root, owner };
  }
  const owner = readPrivate(root, 'owner.json');
  if (owner.uid !== process.getuid() || owner.version !== 1 || owner.rootInode !== stat.ino || !/^[a-f0-9]{32}$/.test(owner.nonce)) fail('PRIVATE_OWNER_REJECTED');
  return { root, owner };
}

function readPrivate(root, name) {
  const file = path.join(root, name), info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o600 || info.size > 32_768) fail('PRIVATE_FILE_REJECTED');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function namespaceFacts({ owner, netNamespace, pidNamespace, devices, ipv4Routes, ipv6Routes }) {
  if (!/^net:\[\d+\]$/.test(owner.hostNetNamespace || '') || !/^pid:\[\d+\]$/.test(owner.hostPidNamespace || '')) fail('HOST_NAMESPACE_PROVENANCE_MISSING');
  if (netNamespace === owner.hostNetNamespace || !/^net:\[\d+\]$/.test(netNamespace)) fail('HOST_NETWORK_NAMESPACE');
  if (pidNamespace === owner.hostPidNamespace || !/^pid:\[\d+\]$/.test(pidNamespace)) fail('HOST_PID_NAMESPACE');
  const interfaces = devices.split('\n').filter((line) => line.includes(':')).map((line) => line.split(':')[0].trim());
  if (interfaces.length !== 1 || interfaces[0] !== 'lo') fail('NON_LOOPBACK_INTERFACE');
  for (const [body, ipv6] of [[ipv4Routes, false], [ipv6Routes, true]]) {
    for (const row of body.split('\n')) {
      const fields = row.trim().split(/\s+/);
      if (!row.trim() || fields[0] === 'Iface') continue;
      if ((ipv6 ? fields.at(-1) : fields[0]) !== 'lo') fail('NON_LOOPBACK_ROUTE');
    }
  }
  return { onlyLoopback: true, differsFromRunnerNetNamespace: true, differsFromRunnerPidNamespace: true };
}

async function requireOfflineNamespace() {
  const { owner } = rootInfo();
  // /proc/self/net is selected by this process's net namespace, unlike an inherited sysfs mount.
  const facts = namespaceFacts({ owner, netNamespace: fs.readlinkSync('/proc/self/ns/net'), pidNamespace: fs.readlinkSync('/proc/self/ns/pid'),
    devices: fs.readFileSync('/proc/self/net/dev', 'utf8'), ipv4Routes: fs.readFileSync('/proc/self/net/route', 'utf8'), ipv6Routes: fs.readFileSync('/proc/self/net/ipv6_route', 'utf8') });
  for (const addresses of Object.values(os.networkInterfaces())) for (const value of addresses || []) if (!value.internal) fail('NON_LOOPBACK_ADDRESS');
  const addresses = await dns.lookup(HOST, { all: true });
  if (!addresses.length || addresses.some((value) => value.address !== '127.0.0.1')) fail('SMTP_HOST_NOT_LOOPBACK');
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') fail('TLS_DISABLED');
  return { ...facts, smtpHostLoopback: true, systemCaChanged: false };
}

function initExit(event, code = 0) {
  if (event === 'driver-exit') return code === 0 ? { reason: 'completed', code: 0 } : { reason: 'child_failed', code: 1 };
  if (event === 'deadline') return { reason: 'deadline', code: 124 };
  if (event === 'parent-eof') return { reason: 'parent_lost', code: 125 };
  if (event === 'signal') return { reason: 'cancelled', code: 143 };
  fail('LIFECYCLE_EVENT_REJECTED');
}

async function pidInit() {
  if (process.pid !== 1) fail('PRIVATE_PID_INIT_REQUIRED');
  const { root } = rootInfo();
  const budget = Number(arg('budget-seconds'));
  if (!Number.isInteger(budget) || budget < 10 || budget > 1560 || process.stdin.isTTY) fail('INIT_LIFETIME_REJECTED');
  let stopped = false, timer;
  const stop = (event, code = 0) => {
    if (stopped) return; stopped = true;
    clearTimeout(timer);
    const decision = initExit(event, code);
    try { writeNew(path.join(root, 'lifecycle.json'), JSON.stringify({ ...decision, pidNamespace: fs.readlinkSync('/proc/self/ns/pid'), netNamespace: fs.readlinkSync('/proc/self/ns/net'), pidOne: process.pid === 1 })); }
    catch { decision.code = 1; }
    // Linux terminates every remaining member when PID 1 exits, including daemonized or setsid descendants.
    process.exit(decision.code);
  };
  process.stdin.once('end', () => stop('parent-eof'));
  process.stdin.once('error', () => stop('parent-eof'));
  process.stdin.resume();
  process.once('SIGTERM', () => stop('signal')); process.once('SIGINT', () => stop('signal'));
  timer = setTimeout(() => stop('deadline'), budget * 1000);
  try {
    await requireOfflineNamespace();
    const driver = arg('driver'), scenario = arg('scenario'), project = arg('project'), reportDir = arg('report-dir');
    if (driver !== path.join(root, 'driver.sh') || !['preflight-only', 'integration'].includes(scenario || '')) fail('INIT_DRIVER_REJECTED');
    const child = spawn('bash', [driver, scenario, project, process.argv[1], root, reportDir], { stdio: ['ignore', 'inherit', 'inherit'] });
    child.once('error', () => stop('driver-exit', 1));
    child.once('exit', (code, signal) => stop('driver-exit', signal ? 1 : code ?? 1));
  } catch { stop('driver-exit', 1); }
}

async function namespaceLaunch() {
  const { root, owner } = rootInfo();
  if (fs.readlinkSync('/proc/self/ns/net') !== owner.hostNetNamespace || fs.readlinkSync('/proc/self/ns/pid') !== owner.hostPidNamespace) fail('RUNNER_NAMESPACE_MISMATCH');
  const uid = process.getuid(), gid = process.getgid();
  const scenario = arg('scenario');
  if (!['preflight-only', 'integration'].includes(scenario || '')) fail('NAMESPACE_SCENARIO_REJECTED');
  const budget = scenario === 'preflight-only' ? 170 : 1550;
  const setup = `set -Eeuo pipefail
mount --make-rprivate /
ip link set lo up
sysctl -q -w net.ipv4.ip_unprivileged_port_start=0
mount --bind "$1/hosts" /etc/hosts
mount -t tmpfs -o mode=1777,nosuid,nodev,size=2G tmpfs /tmp
exec setpriv --reuid="$2" --regid="$3" --init-groups --no-new-privs env HOME="$4" CI=true GITHUB_ACTIONS=true RUNNER_TEMP="$5" PATH="$6" PLAYWRIGHT_BROWSERS_PATH="$7" GITHUB_SHA="$8" "$9" "\${10}" pid-init --root "$1" --project "\${11}" --driver "$1/driver.sh" --scenario "\${12}" --report-dir "\${13}" --budget-seconds "\${14}"`;
  const command = ['-n', '--preserve-env=NEXT_PUBLIC_TURNSTILE_SITE_KEY,TURNSTILE_SECRET_KEY,TURNSTILE_VERIFY_URL,NEXT_PUBLIC_TAWK_PROPERTY_ID,NEXT_PUBLIC_TAWK_WIDGET_ID',
    'unshare', '--mount', '--net', '--pid', '--mount-proc', '--fork', '--kill-child=SIGKILL', 'bash', '-c', setup, 'smtp-namespace',
    root, String(uid), String(gid), process.env.HOME, process.env.RUNNER_TEMP, process.env.PATH, process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(process.env.HOME, '.cache/ms-playwright'), process.env.GITHUB_SHA || '', process.execPath, process.argv[1], arg('project'), scenario, arg('report-dir'), String(budget)];
  // FD 0 is a private pipe: losing this guardian closes it and terminates the namespace init even after guardian SIGKILL.
  const child = spawn('sudo', command, { stdio: ['pipe', 'inherit', 'inherit'] });
  let cancelled = false;
  const abort = () => { cancelled = true; child.stdin.destroy(); child.kill('SIGTERM'); };
  process.once('SIGTERM', abort); process.once('SIGINT', abort);
  child.stdin.on('error', () => {});
  const timer = setTimeout(abort, (budget + 10) * 1000);
  const code = await new Promise((resolve) => {
    child.once('error', () => resolve(1)); child.once('close', (status, signal) => resolve(signal ? 1 : status ?? 1));
  });
  clearTimeout(timer); child.stdin.destroy();
  process.removeListener('SIGTERM', abort); process.removeListener('SIGINT', abort);
  const lifecyclePath = path.join(root, 'lifecycle.json');
  if (!fs.existsSync(lifecyclePath)) fail('PRIVATE_PID_NAMESPACE_NOT_CONFIRMED');
  const lifecycle = readPrivate(root, 'lifecycle.json');
  if (!lifecycle.pidOne || lifecycle.pidNamespace === owner.hostPidNamespace) fail('PRIVATE_PID_NAMESPACE_NOT_CONFIRMED');
  // A privileged, read-only host-proc scan avoids treating inaccessible root processes as absent.
  const scanScript = `const fs=require('node:fs');let count=0;for(const entry of fs.readdirSync('/proc')){if(!/^[0-9]+$/.test(entry))continue;try{if(fs.readlinkSync('/proc/'+entry+'/ns/pid')===process.argv[1])count++}catch(error){if(!['ENOENT','ESRCH'].includes(error.code))process.exit(2)}}process.stdout.write(String(count))`;
  const scan = spawnSync('sudo', ['-n', process.execPath, '-e', scanScript, lifecycle.pidNamespace], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 });
  if (scan.error || scan.status !== 0 || !/^[0-9]+$/.test(scan.stdout || '')) fail('NAMESPACE_EXIT_SCAN_FAILED');
  if (Number(scan.stdout) !== 0) fail('NAMESPACE_DESCENDANTS_REMAIN');
  const publicResult = { privatePidOneConfirmed: true, descendantsRemaining: 0, reason: lifecycle.reason, namespaceExit: true, cancelled };
  if (arg('report-dir')) writeNew(path.join(arg('report-dir'), 'admin-legacy-inquiries-smtp-lifecycle.json'), JSON.stringify(publicResult, null, 2));
  process.exitCode = cancelled || lifecycle.code !== 0 || code !== 0 ? 1 : 0;
}

function prepare() {
  const { root, owner } = rootInfo({ create: true });
  const privateData = {
    owner: owner.nonce, smtpUser: 'evidence-user', smtpPass: randomBytes(24).toString('hex'),
    pgPass: randomBytes(24).toString('hex'), controlKey: randomBytes(24).toString('hex'),
    recipient: `fixture-${owner.nonce}@customer.example.test`,
    authSecret: randomBytes(32).toString('hex'), totpKey: randomBytes(32).toString('base64'), privacySecret: randomBytes(32).toString('hex'),
  };
  writeNew(path.join(root, 'private.json'), JSON.stringify(privateData));
  writeNew(path.join(root, 'pg.pass'), privateData.pgPass + '\n');
  const original = fs.readFileSync('/etc/hosts', 'utf8');
  if (original.split('\n').some((line) => line.split('#')[0].trim().split(/\s+/).includes(HOST))) fail('HOST_MAPPING_ALREADY_PRESENT');
  // CI bind-mounts this copy in a private mount namespace; /etc/hosts on the host is never edited.
  writeNew(path.join(root, 'hosts'), original + `\n127.0.0.1 ${HOST}\n`);
  console.log(JSON.stringify({ prepared: true, privateValuesLogged: false }));
}

function openssl(root, argv) {
  const result = spawnSync('openssl', argv, { cwd: root, stdio: 'ignore', timeout: 30_000 });
  if (result.error || result.status !== 0) fail('OPENSSL_FAILED');
}

function certificates(root) {
  const result = spawnSync('openssl', ['version'], { stdio: 'ignore', timeout: 5_000 });
  if (result.error || result.status !== 0) fail('OPENSSL_UNAVAILABLE');
  writeNew(path.join(root, 'leaf.ext'), `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:${HOST}\n`);
  for (const prefix of ['', 'rogue-']) {
    openssl(root, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1', '-subj', '/CN=Ephemeral SMTP Evidence CA', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-keyout', `${prefix}ca.key.pem`, '-out', `${prefix}ca.cert.pem`]);
    openssl(root, ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-subj', `/CN=${HOST}`, '-keyout', `${prefix}leaf.key.pem`, '-out', `${prefix}leaf.csr.pem`]);
    openssl(root, ['x509', '-req', '-sha256', '-days', '1', '-in', `${prefix}leaf.csr.pem`, '-CA', `${prefix}ca.cert.pem`, '-CAkey', `${prefix}ca.key.pem`, '-set_serial', prefix ? '2' : '1', '-extfile', 'leaf.ext', '-out', `${prefix}leaf.cert.pem`]);
  }
  for (const name of fs.readdirSync(root)) fs.chmodSync(path.join(root, name), 0o600);
}

function envelopeAddress(line, verb) {
  const suffix = verb === 'MAIL FROM' ? '(?: SIZE=[0-9]{1,8})?' : '';
  const matched = new RegExp(`^${verb}:\\s*<([^<>\\r\\n]+)>${suffix}\\s*$`, 'i').exec(line);
  return matched?.[1] || null;
}

function session(socket, shared, privateData, upgrade) {
  let pending = '', dataBytes = 0;
  let ehlo = false, authenticated = false, sender = false, recipient = false, inData = false, authLogin = 0;
  const send = (line) => socket.write(line + '\r\n');
  const reset = () => { sender = false; recipient = false; inData = false; dataBytes = 0; };
  const authPlain = (encoded) => {
    const parts = Buffer.from(encoded, 'base64').toString('utf8').split('\0');
    const ok = parts.length === 3 && same(parts[1], privateData.smtpUser) && same(parts[2], privateData.smtpPass);
    authenticated = ok; if (ok) shared.authenticated++; send(ok ? '235 Authentication accepted' : '535 Authentication rejected');
  };
  const onLine = (line) => {
    if (inData) {
      if (line === '.') {
        shared.received++; shared.acceptedBytes += dataBytes; reset(); send('250 Accepted into local sink');
      } else {
        dataBytes += Buffer.byteLength(line) + 2;
        if (dataBytes > MAX_DATA) { reset(); send('552 Message too large'); socket.end(); }
      }
      return;
    }
    if (Buffer.byteLength(line) > MAX_COMMAND) { send('500 Command too long'); socket.end(); return; }
    if (authLogin) {
      const decoded = Buffer.from(line, 'base64').toString('utf8');
      if (authLogin === 1) { authLogin = same(decoded, privateData.smtpUser) ? 2 : 3; send('334 UGFzc3dvcmQ6'); }
      else { authenticated = authLogin === 2 && same(decoded, privateData.smtpPass); authLogin = 0; if (authenticated) shared.authenticated++; send(authenticated ? '235 Authentication accepted' : '535 Authentication rejected'); }
      return;
    }
    const [verb] = line.split(/\s+/, 1);
    switch (verb?.toUpperCase()) {
      case 'EHLO': case 'HELO':
        ehlo = true; reset();
        send(socket.encrypted ? '250-local-sink\r\n250-AUTH PLAIN LOGIN\r\n250 SIZE 2097152' : '250-local-sink\r\n250-STARTTLS\r\n250 SIZE 2097152');
        break;
      case 'STARTTLS':
        if (socket.encrypted || !ehlo || !upgrade || pending.length) { send('503 STARTTLS rejected'); break; }
        socket.removeListener('data', onData);
        socket.write('220 TLS required\r\n', () => upgrade(socket));
        break;
      case 'AUTH':
        if (!socket.encrypted || !ehlo) { send('530 TLS required'); break; }
        if (/^AUTH PLAIN [A-Za-z0-9+/=]+$/i.test(line)) authPlain(line.split(/\s+/)[2]);
        else if (/^AUTH LOGIN$/i.test(line)) { authLogin = 1; send('334 VXNlcm5hbWU6'); }
        else send('504 Unsupported authentication');
        break;
      case 'MAIL':
        reset();
        if (!authenticated || !ehlo) { send('530 Authentication required'); break; }
        sender = !!envelopeAddress(line, 'MAIL FROM'); send(sender ? '250 Sender accepted' : '501 Invalid envelope');
        break;
      case 'RCPT': {
        if (!authenticated || !sender) { send('503 Envelope required'); break; }
        shared.rcptAttempts++;
        const address = envelopeAddress(line, 'RCPT TO');
        if (!address || !same(address.toLowerCase(), privateData.recipient.toLowerCase())) { shared.rejectedRecipients++; send('550 Local allowlist only'); break; }
        if (shared.failNextRcpt) { shared.failNextRcpt = false; shared.rcptFailures++; send('451 Temporary local refusal'); break; }
        recipient = true; send('250 Recipient accepted'); break;
      }
      case 'DATA':
        if (!authenticated || !sender || !recipient) { send('503 Recipient required'); break; }
        inData = true; dataBytes = 0; send('354 End with dot'); break;
      case 'RSET': reset(); send('250 Reset'); break;
      case 'NOOP': send('250 OK'); break;
      case 'QUIT': send('221 Bye'); socket.end(); break;
      default: send('500 Unsupported command');
    }
  };
  const onData = (chunk) => {
    pending += chunk.toString('utf8');
    for (;;) {
      const at = pending.indexOf('\r\n');
      if (at === -1) break;
      const line = pending.slice(0, at); pending = pending.slice(at + 2); onLine(line);
    }
    if (Buffer.byteLength(pending) > MAX_LINE) { pending = ''; send('552 Line too large'); socket.end(); }
  };
  socket.on('data', onData);
  socket.on('error', () => {});
  socket.setTimeout?.(20_000, () => socket.destroy());
  return { greet: () => send('220 Local SMTP evidence sink'), onLine };
}

async function startSink(root, { rogue = false, control = false } = {}) {
  const privateData = readPrivate(root, 'private.json');
  const prefix = rogue ? 'rogue-' : '';
  const options = { key: fs.readFileSync(path.join(root, `${prefix}leaf.key.pem`)), cert: fs.readFileSync(path.join(root, `${prefix}leaf.cert.pem`)), minVersion: 'TLSv1.2' };
  const secureContext = tls.createSecureContext(options);
  const state = { connections: 0, connections465: 0, connections587: 0, tlsAttempts465: 0, tlsAttempts587: 0,
    certificateAlerts465: 0, certificateAlerts587: 0, authenticated: 0, rcptAttempts: 0, received: 0, acceptedBytes: 0,
    rejectedRecipients: 0, rcptFailures: 0, failNextRcpt: false, tls12: 0, tls13: 0 };
  const sockets = new Set();
  const track = (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('error', () => {}); };
  const secured = (socket, greet) => {
    if (socket.getProtocol() === 'TLSv1.3') state.tls13++; else if (socket.getProtocol() === 'TLSv1.2') state.tls12++; else { socket.destroy(); return; }
    const handler = session(socket, state, privateData);
    if (greet) handler.greet();
  };
  const certificateAlertCodes = new Set(['ERR_SSL_TLSV1_ALERT_UNKNOWN_CA', 'ERR_SSL_SSLV3_ALERT_BAD_CERTIFICATE', 'ERR_SSL_SSLV3_ALERT_CERTIFICATE_UNKNOWN']);
  const noteTlsError = (port, error) => {
    if (port === 465) state.tlsAttempts465++;
    if (certificateAlertCodes.has(error?.code)) state[`certificateAlerts${port}`]++;
  };
  const smtps = tls.createServer(options, (socket) => { state.tlsAttempts465++; secured(socket, true); });
  smtps.on('tlsClientError', (error) => noteTlsError(465, error));
  const starttls = net.createServer((socket) => {
    session(socket, state, privateData, (raw) => {
      state.tlsAttempts587++;
      const upgraded = new tls.TLSSocket(raw, { isServer: true, secureContext, minVersion: 'TLSv1.2' });
      track(upgraded); upgraded.on('error', (error) => noteTlsError(587, error)); upgraded.on('secure', () => secured(upgraded, false));
    }).greet();
  });
  const servers = [smtps, starttls];
  for (let i = 0; i < servers.length; i++) servers[i].on('connection', (socket) => { state.connections++; state[`connections${PORTS[i]}`]++; track(socket); });
  const stats = () => Object.fromEntries(Object.entries(state).filter(([key]) => key !== 'failNextRcpt'));
  if (control) {
    const api = http.createServer((req, res) => {
      const respond = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
      if (req.method === 'GET' && req.url === '/health') return respond(200, { ready: true });
      if (req.method === 'GET' && req.url === '/stats') return respond(200, stats());
      if (req.method === 'POST' && req.url === '/failure/next-rcpt' && same(req.headers['x-mail-evidence-control'], privateData.controlKey)) {
        if (Number(req.headers['content-length'] || 0) !== 0 || req.headers['transfer-encoding']) return respond(400, { error: 'empty_body_required' });
        if (state.failNextRcpt) return respond(409, { error: 'already_armed' });
        state.failNextRcpt = true; return respond(200, { armed: true });
      }
      req.resume(); respond(404, { error: 'not_found' });
    });
    api.headersTimeout = 5_000; api.requestTimeout = 5_000;
    api.on('connection', track); servers.push(api);
  }
  const close = async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.map((server) => server.listening ? new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) : Promise.resolve()));
  };
  try {
    for (let i = 0; i < servers.length; i++) await new Promise((resolve, reject) => { const s = servers[i]; s.once('error', reject); s.listen(i < 2 ? PORTS[i] : 3998, '127.0.0.1', () => { s.removeListener('error', reject); resolve(); }); });
  } catch { await close(); fail('SMTP_PORT_BIND_FAILED'); }
  return { stats, close };
}

function certificateCode(error) {
  for (const key of ['originalCode', 'code']) {
    const value = error?.[key];
    if (typeof value === 'string' && CERTIFICATE_CODES.has(value)) return value;
  }
  return null;
}

/** Observe only certificate categories from the same real send; options, payload, result and thrown error are unchanged. */
function observingTransportFactory(create, observation) {
  return (options) => {
    const transport = create(options);
    return {
      async sendMail(mail) {
        try { return await transport.sendMail(mail); }
        catch (error) { observation.certificateCode = certificateCode(error); throw error; }
      },
      close() { return transport.close?.(); },
    };
  };
}

async function probe() {
  const { root } = rootInfo();
  await requireOfflineNamespace();
  const project = fs.realpathSync(arg('project') || process.cwd());
  const port = Number(arg('port')), expectation = arg('expect');
  if (!PORTS.includes(port) || !['trusted', 'untrusted', 'relay'].includes(expectation)) fail('PROBE_ARGUMENT_REJECTED');
  const secret = readPrivate(root, 'private.json');
  const { smtpConfig } = await import(pathToFileURL(path.join(project, 'src/lib/server/mail/config.ts')));
  const { createSmtpAdapter, smtpTransportOptions } = await import(pathToFileURL(path.join(project, 'src/lib/server/mail/smtp.ts')));
  const env = { SMTP_HOST: HOST, SMTP_PORT: String(port), SMTP_USER: secret.smtpUser, SMTP_PASS: secret.smtpPass, MAIL_FROM: 'Evidence <sender@example.test>', REPLY_DOMAIN: 'reply.example.test', NEXT_PUBLIC_ADMIN_MAIL: 'http' };
  const config = smtpConfig(env); assert.equal(config.ok, true);
  const options = smtpTransportOptions(config.cfg);
  assert.equal(options.logger, false); assert.equal(options.debug, false); assert.equal(options.tls.minVersion, 'TLSv1.2');
  assert.equal(options.tls.rejectUnauthorized, undefined); assert.equal(options.ignoreTLS, false);
  assert.equal(options.secure, port === 465); assert.equal(options.requireTLS, port === 587);
  for (const bad of ['25', '2525']) assert.equal(smtpConfig({ ...env, SMTP_PORT: bad }).ok, false);
  assert.equal(smtpConfig({ ...env, NODE_TLS_REJECT_UNAUTHORIZED: '0' }).ok, false);
  const observation = { certificateCode: null };
  const result = await createSmtpAdapter(config.cfg, {
    createTransport: observingTransportFactory((originalOptions) => nodemailer.createTransport(originalOptions), observation),
  }).send({
    to: expectation === 'relay' ? 'not-allowed@other.example.test' : secret.recipient,
    replyTo: 'probe@reply.example.test', subject: 'Local SMTP evidence', text: 'Synthetic transport probe', html: '<p>Synthetic transport probe</p>',
    messageId: `<${randomBytes(12).toString('hex')}@reply.example.test>`, sendKey: randomBytes(12).toString('hex'),
  });
  if (expectation === 'trusted') assert.equal(result.ok, true);
  else {
    assert.equal(result.ok, false);
    if (expectation === 'relay') { assert.equal(result.reason, 'recipient_rejected'); assert.equal(result.retryable, false); }
    // Nodemailer may wrap certificate errors. Evidence requires rejection before AUTH/DATA, not a fabricated reason code.
  }
  const outcome = { ok: result.ok, reason: result.ok ? 'accepted' : result.reason, code: result.ok ? null : result.code,
    certificateCode: observation.certificateCode };
  process.send?.({ kind: 'smtp-probe-result', port, expectation, ...outcome });
  console.log(JSON.stringify({ expectation, port, passed: true, adapter: 'unchanged-production', ...outcome, rawSmtpLogged: false }));
}

function verifyRogueEvidence(outcome, before, after, port) {
  const explicitCode = CERTIFICATE_CODES.has(outcome.certificateCode) ? outcome.certificateCode : CERTIFICATE_CODES.has(outcome.code) ? outcome.code : null;
  const peerCertificateAlert = after[`certificateAlerts${port}`] > before[`certificateAlerts${port}`];
  if (outcome.ok !== false || (!explicitCode && !peerCertificateAlert)) fail('ROGUE_CERTIFICATE_REJECTION_NOT_PROVEN');
  if (after[`connections${port}`] <= before[`connections${port}`] || after[`tlsAttempts${port}`] <= before[`tlsAttempts${port}`]) fail('ROGUE_LISTENER_NOT_REACHED');
  if (after.authenticated !== before.authenticated || after.received !== before.received) fail('ROGUE_AUTH_OR_DATA_ACCEPTED');
  return { port, listenerReached: true, tlsAttempted: true, safeTlsCode: explicitCode || 'PEER_CERTIFICATE_ALERT',
    adapterCode: outcome.code, adapterReason: outcome.reason, zeroAuthAndData: true };
}

function preflightFailureReport(error) {
  return { ...preflightReport, version: 1, pass: false, code: safeCode(error), rawSmtpLogged: false, systemCaChanged: false };
}

async function preflight() {
  preflightReport = { version: 1, pass: false, stage: 'namespace', completedPortResults: [], positive: null, negative: null,
    rogueConnectionEvidence: [], rawPayloadStored: false, rawSmtpLogged: false, systemCaChanged: false, applicationTlsChanged: false };
  const { root } = rootInfo();
  const isolation = await requireOfflineNamespace();
  Object.assign(preflightReport, isolation);
  preflightReport.stage = 'certificates';
  certificates(root);
  preflightReport.openssl = true;
  const privateData = readPrivate(root, 'private.json');
  const run = (port, expectation) => new Promise((resolve, reject) => {
    // An asynchronous child leaves the local sink event loop free to complete TLS and SMTP.
    const child = spawn(process.execPath, ['--import', 'tsx', process.argv[1], 'probe', '--root', root, '--project', arg('project') || process.cwd(), '--port', String(port), '--expect', expectation], {
      cwd: arg('project') || process.cwd(), env: { ...process.env, NODE_EXTRA_CA_CERTS: path.join(root, 'ca.cert.pem'), NODE_TLS_REJECT_UNAUTHORIZED: undefined }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    let outcome;
    child.on('message', (message) => { if (message?.kind === 'smtp-probe-result' && message.port === port && message.expectation === expectation) outcome = message; });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, 25_000);
    child.once('error', () => { clearTimeout(timer); reject(Object.assign(new Error('PROBE_START_FAILED'), { code: 'PROBE_START_FAILED' })); });
    child.once('close', (code, signal) => { clearTimeout(timer); if (code === 0 && !signal && !timedOut && outcome) resolve(outcome); else { const category = timedOut ? 'PROBE_TIMEOUT' : 'PRODUCTION_ADAPTER_PROBE_FAILED'; reject(Object.assign(new Error(category), { code: category })); } });
  });
  preflightReport.stage = 'trusted-listeners';
  let sink = await startSink(root);
  try {
    for (const port of PORTS) for (const expectation of ['trusted', 'relay']) {
      preflightReport.stage = `${port}-${expectation}`;
      const outcome = await run(port, expectation);
      preflightReport.completedPortResults.push({ port, expectation, outcome, counts: sink.stats() });
    }
    const positive = sink.stats(); assert.equal(positive.received, 2); assert.equal(positive.rejectedRecipients, 2);
  } finally { preflightReport.positive = sink.stats(); await sink.close(); }
  preflightReport.stage = 'rogue-listeners';
  sink = await startSink(root, { rogue: true });
  try {
    for (const port of PORTS) {
      preflightReport.stage = `${port}-untrusted`;
      const before = sink.stats();
      const outcome = await run(port, 'untrusted');
      const deadline = Date.now() + 2_000;
      while (sink.stats()[`tlsAttempts${port}`] <= before[`tlsAttempts${port}`] && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      const portResult = { port, expectation: 'untrusted', outcome, before, counts: sink.stats(), certificateEvidenceVerified: false };
      preflightReport.completedPortResults.push(portResult);
      preflightReport.rogueConnectionEvidence.push(verifyRogueEvidence(outcome, before, portResult.counts, port));
      portResult.certificateEvidenceVerified = true;
    }
    const negative = sink.stats(); assert.equal(negative.received, 0); assert.equal(negative.authenticated, 0);
  } finally { preflightReport.negative = sink.stats(); await sink.close(); }
  assert.equal(privateData.owner, rootInfo().owner.nonce);
  const report = { ...preflightReport, pass: true, stage: 'complete', lowPortBindings: { 465: true, 587: true },
    trustedCaThroughNodeExtraCa: true, unrelatedCaRejectedBeforeAuth: true, relayRecipientsRejectedBeforeData: true };
  if (!arg('report')) fail('REPORT_PATH_REQUIRED');
  writeNew(arg('report'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ smtpPreflight: 'passed', applicationTlsChanged: false, systemCaChanged: false }));
}

function exec() {
  const { root } = rootInfo();
  const secret = readPrivate(root, 'private.json');
  const stage = arg('mode'), cut = args.indexOf('--');
  if (!['postgres', 'http-real', 'http-disabled', 'off'].includes(stage) || cut < 0 || !args[cut + 1]) fail('EXEC_ARGUMENT_REJECTED');
  const env = { ...process.env, POSTGRES_PASSWORD: secret.pgPass, PGPASSWORD: secret.pgPass, POSTGRES_DB: 'mail_evidence', PGDATA: '/tmp/mail-evidence-pg',
    DATABASE_URL: `postgresql://postgres:${secret.pgPass}@127.0.0.1:5432/mail_evidence`,
    CI: 'true', AUTH_SECRET: secret.authSecret, ADMIN_TOTP_KEY: secret.totpKey, PRIVACY_HASH_SECRET: secret.privacySecret,
    AUTH_URL: 'http://localhost:3100', AUTH_TRUST_HOST: 'true', APP_ORIGIN: 'http://localhost:3100', NEXT_PUBLIC_SITE_URL: 'http://localhost:3100', NEXT_PUBLIC_ADMIN_API: 'http', APP_ENV: 'test',
    NEXT_PUBLIC_ADMIN_MAIL: stage === 'off' ? 'off' : 'http', MAIL_SEND_ADAPTER: 'smtp', SMTP_HOST: HOST, SMTP_PORT: '465', SMTP_USER: secret.smtpUser,
    SMTP_PASS: stage === 'http-disabled' ? undefined : secret.smtpPass, MAIL_FROM: 'Evidence <sender@example.test>', REPLY_DOMAIN: 'reply.example.test',
    ADMIN_ALERT_EMAIL: secret.recipient, INQUIRY_NOTIFY_EMAIL: secret.recipient,
    SMTP_EVIDENCE_MODE: stage, SMTP_EVIDENCE_ROOT: root, SMTP_EVIDENCE_RECIPIENT: secret.recipient,
    SMTP_EVIDENCE_CONTROL: secret.controlKey, SMTP_EVIDENCE_TARGET_PATH: path.join(root, 'target.json'),
    NODE_EXTRA_CA_CERTS: path.join(root, 'ca.cert.pem'), NODE_TLS_REJECT_UNAUTHORIZED: undefined,
  };
  const result = spawnSync(args[cut + 1], args.slice(cut + 2), { env, stdio: 'inherit' });
  if (result.error || result.signal) fail('CHILD_INTERRUPTED');
  process.exitCode = result.status || 0;
}

async function serve() {
  const { root } = rootInfo(); await requireOfflineNamespace();
  const sink = await startSink(root, { control: true });
  console.log(JSON.stringify({ smtpSinkReady: true, loopbackOnly: true, noRelay: true }));
  let shuttingDown = false;
  const stop = async () => {
    if (shuttingDown) return; shuttingDown = true;
    try { await sink.close(); if (arg('report')) writeNew(arg('report'), JSON.stringify({ stopped: true, ...sink.stats() }, null, 2)); }
    catch { console.error('SMTP_SINK_CLEANUP_FAILED'); process.exitCode = 1; }
  };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}

function cleanup() {
  const { root } = rootInfo();
  for (const name of fs.readdirSync(root)) {
    const stat = fs.lstatSync(path.join(root, name));
    if (!FILES.has(name) || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid()) fail('CLEANUP_CONTENT_REJECTED');
  }
  // The complete absolute root, inode, owner, direct parent and file whitelist have been checked.
  fs.rmSync(root, { recursive: true, force: false });
  console.log(JSON.stringify({ privateCleanup: true, filesOutsideRootTouched: false }));
}

async function selfCheck() {
  assert.equal(envelopeAddress('RCPT TO:<a@b.test>', 'RCPT TO'), 'a@b.test');
  assert.equal(envelopeAddress('RCPT TO:<a@b.test> OR <other@b.test>', 'RCPT TO'), null);
  assert.equal(envelopeAddress('RCPT TO:<a@b.test>\r\nDATA', 'RCPT TO'), null);
  assert.equal(same('a', 'a'), true); assert.equal(same('a', 'b'), false);
  const output = [], socket = { encrypted: false, write: (v) => output.push(v), on() {}, end() {}, setTimeout() {} };
  const state = { authenticated: 0, rcptAttempts: 0, received: 0, acceptedBytes: 0, rejectedRecipients: 0, rcptFailures: 0, failNextRcpt: false };
  const s = session(socket, state, { smtpUser: 'unit', smtpPass: 'unit', recipient: 'unit@example.test' });
  s.onLine('EHLO unit'); s.onLine('AUTH LOGIN'); s.onLine('MAIL FROM:<unit@example.test>'); s.onLine('DATA');
  assert.equal(state.authenticated, 0); assert.equal(state.received, 0); assert.ok(output.some((v) => v.startsWith('530 TLS required')));
  const encryptedOutput = [], encrypted = { ...socket, encrypted: true, write: (v) => encryptedOutput.push(v) };
  const secured = session(encrypted, state, { smtpUser: 'unit', smtpPass: 'unit', recipient: 'unit@example.test' });
  secured.onLine('EHLO unit'); secured.onLine('AUTH PLAIN ' + Buffer.from('\0unit\0unit').toString('base64'));
  secured.onLine('MAIL FROM:<unit@example.test> SIZE=123'); secured.onLine('RCPT TO:<other@example.test>');
  assert.equal(state.rejectedRecipients, 1); secured.onLine('DATA'); assert.equal(state.received, 0);
  secured.onLine('RSET'); secured.onLine('MAIL FROM:<unit@example.test>'); state.failNextRcpt = true;
  secured.onLine('RCPT TO:<unit@example.test>'); assert.equal(state.rcptFailures, 1); secured.onLine('DATA'); assert.equal(state.received, 0);
  secured.onLine('RSET'); secured.onLine('MAIL FROM:<unit@example.test>'); secured.onLine('RCPT TO:<unit@example.test>');
  secured.onLine('DATA'); secured.onLine('Synthetic unit content'); secured.onLine('.'); assert.equal(state.received, 1);
  assert.ok(encryptedOutput.some((v) => v.startsWith('451 Temporary local refusal')));
  const owner = { hostNetNamespace: 'net:[100]', hostPidNamespace: 'pid:[200]' };
  const good = { owner, netNamespace: 'net:[101]', pidNamespace: 'pid:[201]', devices: 'Inter-| Receive\n lo: 0 0 0 0', ipv4Routes: 'Iface Destination\nlo 00000000', ipv6Routes: '00000000000000000000000000000000 lo' };
  assert.equal(namespaceFacts(good).differsFromRunnerNetNamespace, true);
  for (const mutation of [{ netNamespace: owner.hostNetNamespace }, { pidNamespace: owner.hostPidNamespace }, { devices: good.devices + '\neth0: 0 0' }, { ipv4Routes: 'Iface Destination\neth0 00000000' }]) assert.throws(() => namespaceFacts({ ...good, ...mutation }));
  const before = { connections465: 0, tlsAttempts465: 0, certificateAlerts465: 0, authenticated: 0, received: 0 };
  const connected = { ...before, connections465: 1, tlsAttempts465: 1 };
  const rejected = { ok: false, reason: 'smtp_tls', code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' };
  assert.equal(verifyRogueEvidence(rejected, before, connected, 465).listenerReached, true);
  assert.throws(() => verifyRogueEvidence(rejected, before, before, 465), /ROGUE_LISTENER_NOT_REACHED/);
  assert.throws(() => verifyRogueEvidence({ ok: false, reason: 'send_unavailable', code: 'ECONNREFUSED' }, before, connected, 465), /ROGUE_CERTIFICATE_REJECTION_NOT_PROVEN/);
  assert.throws(() => verifyRogueEvidence(rejected, before, { ...connected, authenticated: 1 }, 465), /ROGUE_AUTH_OR_DATA_ACCEPTED/);
  const wrappedCertificate = { ok: false, reason: 'send_unavailable', code: 'ESOCKET', certificateCode: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' };
  assert.equal(verifyRogueEvidence(wrappedCertificate, before, connected, 465).safeTlsCode, wrappedCertificate.certificateCode);
  for (const code of ['ESOCKET', 'ECONNREFUSED', 'ETIMEDOUT']) {
    assert.equal(certificateCode({ code }), null);
    assert.equal(certificateCode({ code: 'ESOCKET', originalCode: code }), null);
    assert.throws(() => verifyRogueEvidence({ ok: false, reason: 'send_unavailable', code, certificateCode: null }, before, connected, 465), /ROGUE_CERTIFICATE_REJECTION_NOT_PROVEN/);
  }
  assert.throws(() => verifyRogueEvidence(wrappedCertificate, before, before, 465), /ROGUE_LISTENER_NOT_REACHED/);
  assert.throws(() => verifyRogueEvidence(wrappedCertificate, before, { ...connected, received: 1 }, 465), /ROGUE_AUTH_OR_DATA_ACCEPTED/);
  assert.equal(certificateCode({ code: 'ESOCKET', originalCode: 'not-a-certificate-code' }), null);
  for (const rejectedSend of [false, true]) {
    const options = { marker: 'original-options' }, mail = { marker: 'original-mail' }, result = { marker: 'original-result' };
    const originalError = Object.assign(new Error('unit-private-error-marker'), { code: 'ESOCKET', originalCode: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', response: 'unit-private-response-marker' });
    const beforeError = Object.getOwnPropertyDescriptors(originalError);
    let created = 0, sends = 0, closes = 0;
    const realTransport = {
      async sendMail(value) { assert.equal(this, realTransport); assert.equal(value, mail); sends++; if (rejectedSend) throw originalError; return result; },
      close() { assert.equal(this, realTransport); closes++; return 'closed'; },
    };
    const observation = { certificateCode: null };
    const wrapped = observingTransportFactory((value) => { assert.equal(value, options); created++; return realTransport; }, observation)(options);
    try {
      if (rejectedSend) await assert.rejects(() => wrapped.sendMail(mail), (error) => error === originalError);
      else assert.equal(await wrapped.sendMail(mail), result);
    } finally { assert.equal(wrapped.close(), 'closed'); }
    assert.deepEqual([created, sends, closes], [1, 1, 1]);
    assert.equal(observation.certificateCode, rejectedSend ? 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' : null);
    assert.deepEqual(Object.getOwnPropertyDescriptors(originalError), beforeError);
    const serialized = JSON.stringify(observation);
    assert.equal(serialized.includes(originalError.message), false); assert.equal(serialized.includes(originalError.response), false);
    assert.deepEqual(Object.keys(observation), ['certificateCode']);
  }
  const originalProgress = preflightReport;
  preflightReport = { stage: '465-untrusted', completedPortResults: [{ port: 465, expectation: 'trusted', outcome: { ok: true, code: null }, counts: { received: 1 } }],
    positive: { received: 2, rejectedRecipients: 2 }, negative: { connections465: 1, authenticated: 0, received: 0 } };
  const privateError = Object.assign(new Error('unit-private-failure-text'), { code: 'ROGUE_CERTIFICATE_REJECTION_NOT_PROVEN', response: 'unit-private-failure-response' });
  const failureReport = preflightFailureReport(privateError), serializedReport = JSON.stringify(failureReport);
  assert.equal(failureReport.pass, false); assert.equal(failureReport.code, privateError.code);
  assert.equal(failureReport.completedPortResults.length, 1); assert.equal(failureReport.positive.received, 2);
  assert.equal(failureReport.negative.connections465, 1); assert.equal(failureReport.stage, '465-untrusted');
  assert.equal(serializedReport.includes(privateError.message), false); assert.equal(serializedReport.includes(privateError.response), false);
  preflightReport = originalProgress;
  for (const event of ['deadline', 'parent-eof', 'signal']) assert.notEqual(initExit(event).code, 0);
  assert.notEqual(initExit('driver-exit', 1).code, 0); assert.equal(initExit('driver-exit', 0).code, 0);
  console.log(JSON.stringify({ offlineSelfCheck: true, namespaceRejectionControls: 4, rogueRejectionControls: 8, transparentTransportControls: 2, failureReportControls: 1,
    lifecycleDecisionControls: 5, networkStarted: false, opensslExecuted: false }));
}

try {
  process.umask(0o077);
  if (mode === 'self-check') await selfCheck();
  else if (mode === 'prepare') prepare();
  else if (mode === 'namespace-launch') await namespaceLaunch();
  else if (mode === 'pid-init') await pidInit();
  else if (mode === 'preflight') await preflight();
  else if (mode === 'probe') await probe();
  else if (mode === 'serve') await serve();
  else if (mode === 'exec') { await requireOfflineNamespace(); exec(); }
  else if (mode === 'cleanup') cleanup();
  else fail('UNKNOWN_MODE');
} catch (error) {
  // Only a bounded category is printed; SMTP errors, credentials, paths and raw AUTH/DATA are excluded.
  const category = safeCode(error);
  console.error(JSON.stringify({ smtpEvidence: 'failed', code: category }));
  if (mode === 'preflight' && arg('report') && !fs.existsSync(arg('report'))) {
    try { writeNew(arg('report'), JSON.stringify(preflightFailureReport(error), null, 2)); }
    catch { console.error('PREFLIGHT_REPORT_WRITE_FAILED'); }
  }
  process.exitCode = 1;
}
