'use strict';

const fs = require('node:fs');
const { sha256Buffer } = require('./j7-digest.cjs');

const MAX_REPORT_BYTES = 1024 * 1024;
const OBJECT_ID = /^[0-9a-f]{40}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const PORTS = [
  { port: 3100, host: '0.0.0.0', observedBy: 'ports.cjs', during: 'in-use' },
  { port: 3101, host: '127.0.0.1', observedBy: 'tcp-connect', during: 'in-use' },
  { port: 3999, host: '127.0.0.1', observedBy: 'ports.cjs', during: 'unknown' },
];
const ROLES = ['app', 'init', 'stop'];

class CleanupError extends Error {}

function expect(condition, code) {
  if (!condition) throw new CleanupError(`CLEANUP_${code}`);
}

function sameHex(left, right, pattern) {
  return typeof left === 'string' && typeof right === 'string' && pattern.test(left) && pattern.test(right) &&
    left.toLowerCase() === right.toLowerCase();
}

function empty(value) {
  return Array.isArray(value) && value.length === 0;
}

function positiveInt(value) {
  return Number.isSafeInteger(value) && value > 0;
}

// The digest and parsed data must describe the same read of the attachment.
function readEvidence(file) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
  const descriptor = fs.openSync(file, flags);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_REPORT_BYTES) throw new Error('Invalid evidence file');
    const buffer = Buffer.alloc(stat.size + 1);
    const length = fs.readSync(descriptor, buffer, 0, buffer.length, null);
    if (length !== stat.size) throw new Error('Evidence size changed');
    const data = buffer.subarray(0, length);
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid evidence object');
    return { value, bytes: length, sha256: sha256Buffer(data).toUpperCase() };
  } finally {
    fs.closeSync(descriptor);
  }
}

function validateRun(cleanup, run, source, reports) {
  const observed = cleanup.run;
  expect(positiveInt(run?.id) && positiveInt(run?.attempt) && cleanup.runId === run.id && cleanup.attempt === run.attempt &&
    observed?.id === run.id && observed?.attempt === run.attempt, 'RUN');
  expect(observed.job === 'e2e' && observed.workflow === 'CI' && observed.workflow === run.workflow && observed.ref === run.ref,
    'JOB');
  const event = /^refs\/pull\/[1-9][0-9]*\/merge$/.test(run.ref) ? 'pull_request' : run.ref === 'refs/heads/main' ? 'push' : null;
  expect(event && observed.event === event && observed.sameCommit === true &&
    sameHex(observed.githubSha, source?.commit, OBJECT_ID) && sameHex(observed.head, source?.commit, OBJECT_ID) &&
    sameHex(observed.tree, source?.tree, OBJECT_ID) && sameHex(cleanup.tree, source?.tree, OBJECT_ID), 'SOURCE');
  for (const report of reports) {
    expect(report.run?.id === run.id && report.run?.attempt === run.attempt && report.run?.workflow === observed.workflow &&
      sameHex(report.source?.commit, source.commit, OBJECT_ID) && sameHex(report.source?.tree, source.tree, OBJECT_ID), 'REPORT_IDENTITY');
  }
}

function validateBuild(build, reports, expectedBuild) {
  expect(build?.kind === 'e2e-test-build' && build.stable === true && build.buildId === expectedBuild?.buildId &&
    typeof build.buildId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(build.buildId) && positiveInt(build.files), 'BUILD');
  expect(Array.isArray(build.appEnvAtBuild) && build.appEnvAtBuild.length === 1 &&
    ['unset', 'test'].includes(build.appEnvAtBuild[0]), 'BUILD_MODE');
  expect(positiveInt(build.serverJs?.bytes) && typeof build.serverJs.sha256 === 'string' && SHA256.test(build.serverJs.sha256), 'SERVER_JS');
  if (expectedBuild.serverJsPath && fs.existsSync(expectedBuild.serverJsPath)) {
    const local = fs.readFileSync(expectedBuild.serverJsPath);
    expect(local.length === build.serverJs.bytes && sameHex(sha256Buffer(local), build.serverJs.sha256, SHA256), 'SERVER_JS');
  }
  if (expectedBuild.standaloneTreeSha256 !== undefined) {
    expect(sameHex(build.standaloneTreeSha256, expectedBuild.standaloneTreeSha256, SHA256), 'BUILD_TREE');
  }
  for (const report of reports) {
    expect(report.build?.buildId === build.buildId && report.build?.files === build.files &&
      sameHex(report.build?.standaloneTreeSha256, build.standaloneTreeSha256, SHA256), 'REPORT_BUILD');
  }
}

function validateStop(cleanup) {
  expect(cleanup.observed === true && cleanup.appStopped === true && cleanup.probeExited === true, 'FLAGS');
  expect(empty(cleanup.listeningAfter), 'LISTENING');
  expect(cleanup.strayLogs === 0 && cleanup.logs?.private === true && cleanup.logs?.uploaded === false &&
    cleanup.logs?.strayInEvidenceDir === 0, 'LOGS');
  expect(Array.isArray(cleanup.ports) && cleanup.ports.length === PORTS.length, 'PORTS');
  for (const { port, host, observedBy, during } of PORTS) {
    const row = cleanup.ports.find((entry) => entry?.port === port);
    expect(row && row.host === host && row.state === 'free' && row.before === 'free' && row.after === 'free' && row.during === during,
      'PORT_STATE');
    expect(row.observedBy === observedBy, 'PORT_OBSERVER');
    expect(row.afterProbeExit === 0, 'PORT_RC');
  }
  expect(Array.isArray(cleanup.roles) && cleanup.roles.length === ROLES.length, 'ROLES');
  for (const role of ROLES) {
    expect(cleanup.roles.find((entry) => entry?.role === role)?.exit === 0, 'ROLE_EXIT');
  }
  expect(Array.isArray(cleanup.instances) && cleanup.instances.length === 2, 'INSTANCES');
  const full = cleanup.instances.find((item) => item?.id === 'j7-full' && item.mode === 'full' && item.port === 3100);
  const fresh = cleanup.instances.find((item) => item?.id === 'j7-nodata' && item.mode === 'nodata' && item.port === 3101);
  for (const row of [full, fresh]) {
    expect(positiveInt(row?.pid) && row.health?.http === 200 && positiveInt(row.health.checks) && row.listeningObserved === true &&
      row.probe?.exit === 0 && row.stop?.pidGone === true && row.stop.portReleased === true &&
      ['TERM', 'KILL'].includes(row.stop.signal), 'INSTANCE_STOP');
  }
  return { full, fresh };
}

function validateDatabase(db, probe, nodata, requireLegacyServiceTag) {
  const service = db?.service;
  expect(service?.image === 'postgres:17' && (!requireLegacyServiceTag || service.stoppedBy === 'runner') &&
    positiveInt(service.versionNum) && Math.floor(service.versionNum / 10000) === 17, 'PG_SERVICE');
  for (const report of [probe, nodata]) {
    expect(report.pg?.versionNum === service.versionNum && sameHex(report.pg?.clusterSha256, service.clusterSha256, SHA256), 'PG_IDENTITY');
  }
  expect(db.full?.database === 'e2e' && db.full.database === probe.pg.database && db.full.created === false &&
    db.full.identityVerified === true, 'FULL_DB');
  const fresh = db.fresh;
  expect(typeof fresh?.database === 'string' && /^e2e_j7_[0-9a-f]{12}$/.test(fresh.database) &&
    fresh.database === nodata.pg.database && fresh.database === nodata.noData?.models?.database &&
    nodata.noData.models.modelRows === 0 && fresh.created === true && fresh.emptyVerified === true &&
    fresh.dropped === true && fresh.goneVerified === true, 'FRESH_DB');
}

function validateReportFiles(files, probe, nodata) {
  expect(Array.isArray(files) && files.length === 2, 'REPORT_FILES');
  for (const [name, report] of [['j7-attribution.json', probe], ['j7-nodata.json', nodata]]) {
    const row = files.find((item) => item?.name === name);
    expect(row?.bytes === report.bytes && sameHex(row?.sha256, report.sha256, SHA256), 'REPORT_DIGEST');
  }
}

function admitCleanup(attachment, probe, nodata, { run, source, build, requireLegacyServiceTag = true }) {
  const value = attachment.value;
  expect(value.schema === 'j7-cleanup/2', 'SCHEMA');
  expect(value.outcome === 'success' && value.phase === 'complete' && empty(value.failures), 'OUTCOME');
  expect(probe.value.schema === 'j7-probe/3' && probe.value.pass === true && probe.value.mode === 'full' &&
    nodata.value.schema === 'j7-nodata/1' && nodata.value.pass === true && nodata.value.mode === 'nodata', 'REPORT_PROFILE');
  const reports = [probe.value, nodata.value];
  validateRun(value, run, source, reports);
  validateBuild(value.build, reports, build);
  const { full, fresh } = validateStop(value);
  validateDatabase(value.db, ...reports, requireLegacyServiceTag);
  validateReportFiles(value.evidence?.files, probe, nodata);
  const { runId, attempt, tree, appStopped, probeExited, listeningAfter, strayLogs, ports, roles, observed } = value;
  const projection = { runId, attempt, tree, appStopped, probeExited, listeningAfter, strayLogs, ports, roles, observed,
    sourceSha256: attachment.sha256 };
  return { projection, full, fresh, build: value.build };
}

module.exports = { CleanupError, readEvidence, admitCleanup };
