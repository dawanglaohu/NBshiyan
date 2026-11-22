import assert from 'node:assert/strict';

// J2 seam comparisons. They take the safe snapshots produced by chat-notifications-phase.mjs and
// never see body text, cookies or addresses: the conversation is projected as scalars plus two
// digests, and the notification row publishes operational columns plus digests of its lease owner
// and provider message id, so those two values are only ever compared in process.
export const CONVERSATION_HTTP_FIELDS = [
  'status', 'version', 'createdAt', 'updatedAt', 'lastActivityAt', 'retainUntil', 'anonymizedAt',
  'lastSeq', 'nextAfterSeq', 'hasMore', 'readLastSeq', 'messages',
];
export const CONVERSATION_DB_FIELDS = [
  'id', 'status', 'version', 'lastSeq', 'visitorReadSeq', 'createdAt', 'updatedAt', 'lastActivityAt',
  'retainUntil', 'anonymizedAt', 'locale', 'productSlug', 'identityDigest', 'messageCount', 'messageDigest',
];
export const OUTBOX_FIELDS = [
  'id', 'conversationId', 'messageId', 'status', 'attempts', 'availableAt', 'leaseVersion',
  'stableMessageId', 'lockedUntil', 'requestStartedAt', 'lastErrorCode', 'sentAt', 'createdAt', 'updatedAt',
  'leaseHeld', 'ownerDigest', 'providerDigest', 'digest',
];

function part(snapshot, name, tag) {
  assert.ok(snapshot && typeof snapshot === 'object', `${tag}: missing ${name} snapshot`);
  assert.ok(snapshot[name] && typeof snapshot[name] === 'object', `${tag}: ${name} projection is absent`);
  return snapshot[name];
}

/** The HTTP projection must be identical: status, read cursor, page geometry and message identities. */
export function assertHttpStable(tag, before, after) {
  const left = part(before, 'http', tag);
  const right = part(after, 'http', tag);
  for (const key of CONVERSATION_HTTP_FIELDS) {
    assert.deepEqual(right[key], left[key], `${tag}: http.${key} changed`);
  }
}

/** The stored conversation and every stored message must be identical, including the digests. */
export function assertDbStable(tag, before, after) {
  const left = part(before, 'db', tag);
  const right = part(after, 'db', tag);
  for (const key of CONVERSATION_DB_FIELDS) {
    assert.deepEqual(right[key], left[key], `${tag}: db.${key} changed`);
  }
}

/** Only the visitor read position may differ; nothing else in the conversation or its messages may move. */
export function assertConversationExceptRead(tag, before, after) {
  const left = part(before, 'db', tag);
  const right = part(after, 'db', tag);
  for (const key of CONVERSATION_DB_FIELDS.filter((name) => name !== 'visitorReadSeq')) {
    assert.deepEqual(right[key], left[key], `${tag}: db.${key} changed outside the read position`);
  }
  if (before.http && after.http) {
    for (const key of CONVERSATION_HTTP_FIELDS.filter((name) => name !== 'readLastSeq')) {
      assert.deepEqual(after.http[key], before.http[key], `${tag}: http.${key} changed outside the read position`);
    }
  }
}

/** Read polls and delivery retries must never move the cursor. */
export function assertReadUnchanged(tag, before, after) {
  assert.deepEqual(part(after, 'db', tag).visitorReadSeq, part(before, 'db', tag).visitorReadSeq, `${tag}: db.visitorReadSeq moved`);
  if (before.http && after.http) {
    assert.deepEqual(after.http.readLastSeq, before.http.readLastSeq, `${tag}: http.readLastSeq moved`);
  }
}

/** The whole target outbox row, including lease and delivery columns, must be unchanged. */
export function assertOutboxStable(tag, before, after) {
  const left = part(before, 'outbox', tag);
  const right = part(after, 'outbox', tag);
  for (const key of OUTBOX_FIELDS) {
    assert.deepEqual(right[key], left[key], `${tag}: outbox.${key} changed`);
  }
}

/** No visitor body, address or cookie marker may reach the artifact. */
export const PRIVATE_MARKERS = ['m4t4-private-', '@example.test', 'HttpOnly'];
export function assertSafe(tag, value) {
  const text = JSON.stringify(value);
  for (const marker of PRIVATE_MARKERS) {
    assert.equal(text.includes(marker), false, `${tag}: artifact carries the private marker ${marker}`);
  }
}
