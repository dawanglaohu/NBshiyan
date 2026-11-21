'use strict';

const CONSENT_PATH = '/api/analytics/consent';
const CONSENT_ROUTE = `POST ${CONSENT_PATH}`;
const CONSENT_IDS = Object.freeze(['consent-accept', 'consent-withdraw', 'consent-reaccept']);

function consentHttp(http) {
  if (!Array.isArray(http)) return null;
  const rows = http.filter((row) => CONSENT_IDS.includes(row?.id) || row?.path === CONSENT_PATH);
  return rows.length === CONSENT_IDS.length && rows.every((row, index) =>
    row.id === CONSENT_IDS[index] && row.method === 'POST' && row.path === CONSENT_PATH && row.status === 200)
    ? rows : null;
}

function consentCounter(counters) {
  const rows = Array.isArray(counters?.rows) ? counters.rows.filter((row) => row?.routeId === CONSENT_ROUTE) : [];
  return rows.length === 1 ? rows[0] : null;
}

module.exports = { CONSENT_IDS, CONSENT_ROUTE, consentHttp, consentCounter };
