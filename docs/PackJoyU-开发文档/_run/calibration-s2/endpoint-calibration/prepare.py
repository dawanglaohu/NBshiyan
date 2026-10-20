import hashlib
import json
import shutil
from pathlib import Path

ROOT = Path('D:/xiangmu/NBshiyan-docs-s2-s6')
OUT = Path('D:/xiangmu/.codex-plans/NBshiyan-docs-s2-s6/endpoint-calibration')
DOCS = ROOT / 'docs/PackJoyU-开发文档'
OUT.mkdir(parents=True, exist_ok=True)
source = json.loads((DOCS / '_run/endpoints-contract.json').read_text(encoding='utf-8-sig'))
assert len(source) == 37

# Faithful English translations of input, output, and permissions, in source method order.
translations = [
('The existing Auth.js protocol. Credentials adds mode and rememberDevice; the old password+totp request may be retained. A nonempty recoveryCode is explicitly rejected for routine sign-in.', 'The original Auth.js redirect/CSRF/session protocol. The session may add a non-credential sid summary and effectiveExpiresAt.', 'Auth.js controls authorization. Failure does not disclose the account sign-in mode.'),
('The existing Auth.js protocol. Credentials adds mode and rememberDevice; the old password+totp request may be retained. A nonempty recoveryCode is explicitly rejected for routine sign-in.', 'The original Auth.js redirect/CSRF/session protocol. The session may add a non-credential sid summary and effectiveExpiresAt.', 'Auth.js controls authorization. Failure does not disclose the account sign-in mode.'),
('The existing email/password/token fields.', 'The existing {otpauthUri}; fix only the final compare-and-swap against the current token and sessionVersion (sv).', 'The existing one-time enrollment credential is required.'),
('The existing email/password/token/totp fields.', 'The existing {recoveryCodes}.', 'The existing enrollment window and a new code usable only once are required.'),
('newPassword and a PASSWORD actionGrant. When supporting the old currentPassword+totp request, perform the same fresh verification within the same final transaction. Reject a nonempty recoveryCode.', 'The existing {ok:true,reauthRequired:true}.', 'The current account owner only, exact same origin, fresh verification with the current password and a new TOTP; revoke all sessions.'),
('A TOTP_RESET actionGrant. The old currentPassword+totp request also follows the same rules. A recovery code cannot use this shortcut.', 'The existing ok/reenrollRequired/enrollLink fields. Set a restricted recovery cookie; the link goes to the restricted reenrollment page.', 'Fresh verification by the account owner. Preserve the original effective factor until final new enrollment. The temporary reenrollment record is restricted.'),
('A RECOVERY_AUTHORIZE actionGrant bound to target=id, and reason.', 'A restricted RecoveryPermitDTO. Migrate the old UI to consume a one-time permit; there is no direct-reset bypass without verification.', 'ADMIN only, cannot target oneself, exact same origin. Reject the old direct reset request without a body.'),
('None.', 'AccountDTO: id/name/email/role/passwordlessEnabled/totpEnabled and the current device summary.', 'A currently valid backend account, ADMIN/SALES/EDITOR.'),
('An empty object. A throttled call on real foreground activity.', 'SessionActivityDTO: effectiveExpiresAt and absoluteExpiresAt. Refresh through a real Set-Cookie response.', 'A currently valid device, exact same origin, any backend role.'),
('purpose, optional targetId, totp, and also password.', 'ActionGrantDTO: token, purpose, expiresAt.', 'A currently valid device, exact same origin. The purpose determines the target rules.'),
('passwordlessEnabled and actionGrant.', 'AccountModeDTO: passwordlessEnabled and changedAt. On success revoke old sessions and sign in again.', 'The account owner, with TOTP currently enrolled, and a single-purpose LOGIN_MODE grant.'),
('Optional cursor; limit at most 50.', 'CursorPage<DeviceDTO>, devices belonging only to the current account, marked current/expiry/revoked.', 'A currently valid backend account.'),
('actionGrant with purpose DEVICE_REVOKE and target=id.', 'DeviceRevokeDTO: id and revokedAt. Repetition returns the same result.', 'Only the current account own devices. The current sid may revoke itself.'),
('actionGrant with purpose LOGOUT_ALL.', 'SignedOutDTO. Clear the Auth.js cookie.', 'A currently valid backend account. Increment sv and revoke devices atomically.'),
('targetUserId, reason, actionGrant.', 'RecoveryPermitDTO: token and expiresAt; return the token only once.', 'ADMIN, RECOVERY_AUTHORIZE bound to the target, cannot authorize oneself.'),
('email, credentialKind RECOVERY_CODE/PERMIT, credential.', 'RecoveryStateDTO: restricted and expiresAt. Also set a restricted HttpOnly cookie.', 'An independent recovery credential is required; this is not a backend session.'),
('An empty object.', 'RecoveryEnrollDTO: otpauthUri and expiresAt.', 'Only a valid restricted recovery cookie.'),
('totp.', 'RecoveryCompleteDTO: completed and recoveryCodes. Clear the restricted cookie. Do not directly grant ADMIN privileges.', 'Only a valid restricted session and the new TOTP.'),
('locale en/ru. Only when the visitor actively contacts the business.', 'ChatSessionDTO: available and expiresAt. Set the necessary cookie.', 'Exact same origin and rate limiting. Does not depend on analytics consent.'),
('clientConversationId, clientMessageId, locale, bodyText, optional email/productSlug/sourcePath.', 'ConversationReceivedDTO: conversationId, message, receivedAt, duplicate.', 'A valid visitor cookie and exact same origin.'),
('afterSeq=0 and limit=50, maximum 100.', 'ChatSyncDTO: conversation, messages, lastSeq, nextAfterSeq, hasMore, read.', 'Only the caller own valid visitor cookie.'),
('clientMessageId, bodyText.', 'MessageReceivedDTO: message, receivedAt, duplicate.', 'Only the owner, conversation OPEN, exact same origin.'),
('lastReadSeq.', 'ReadDTO: lastReadSeq.', 'Only the caller own visitor cookie, exact same origin, move the cursor monotonically forward.'),
('Optional status/cursor/unreadOnly; limit=25, maximum 100.', 'CursorPage<ChatSummaryDTO> and the current operator own total unread count.', 'ADMIN/SALES shared chat scope. Reject EDITOR.'),
('afterSeq=0 and limit=50, maximum 100.', 'AdminChatSyncDTO. Message bodies according to authorization; contains no visitor cookie or token.', 'ADMIN/SALES.'),
('clientMessageId, bodyText.', 'MessageReceivedDTO. Determine the author from the session.', 'ADMIN/SALES, conversation OPEN, exact same origin.'),
('lastReadSeq.', 'ReadDTO.', 'ADMIN/SALES, change only the caller own cursor, exact same origin.'),
('status=CLOSED, expectedVersion.', 'ChatStatusDTO: status, version, updatedAt.', 'ADMIN/SALES, exact same origin, compare-and-swap.'),
('analytics Boolean, consentVersion.', 'ConsentDTO: analytics, expiresAt. Sign an anonymous cookie upon consent; clear the cookie upon withdrawal.', 'Same origin, no sign-in required, do not track those who decline.'),
('events[1..20]: eventId/kind/occurredAt/locale and navigationId/viewId/productSlug/path as required by each kind.', 'AnalyticsReceiptDTO: acceptedIds, duplicateIds, receivedAt.', 'A valid analytics-consent cookie and same origin. Without consent return 403 and persist no event.'),
('None.', 'AnalyticsSettingsDTO: version/timezone/timezoneRevision/recomputableFrom.', 'ADMIN.'),
('timezone, expectedVersion.', 'AnalyticsSettingsDTO and rebuildScheduled.', 'ADMIN, same origin, compare-and-swap and audit.'),
('from/to in local calendar days, optional productSlug/timezoneRevision/sources.', 'StatsDTO: authorized source list, metrics, coverage, actual data time, and separate status for each source.', 'ADMIN all sources; SALES business scope; EDITOR public traffic and 3D.'),
('jobKey from a fixed allowlist; optional dryRun only for retention jobs.', 'JobResultDTO: jobKey/status/counts/finishedAt.', 'Bearer CRON_SECRET with constant-time verification. No arbitrary job or code.'),
('The existing protocol.', 'The existing stale/sent/failed/deferred/dropped counts.', 'First check the existing mail feature switch, then Bearer CRON_SECRET. Add real scheduling in this iteration.'),
('The existing protocol.', 'The existing stale/sent/failed/deferred/dropped counts.', 'First check the existing mail feature switch, then Bearer CRON_SECRET. Add real scheduling in this iteration.'),
('source STORAGE/BACKUP, measuredAt, status, values/safeErrorCode from a strict allowlist.', 'OpsReportReceiptDTO: accepted, measuredAt.', 'Bearer CRON_SECRET. A controlled server reporting script; accepts neither a browser session nor arbitrary paths.'),
]
assert len(translations) == 37

roles = ['anonymous', 'visitor_session', 'authenticated_self', 'EDITOR', 'SALES', 'ADMIN', 'cron']
role_definitions = {
    'anonymous': 'No backend account session or backend role. An endpoint may still require a particular enrollment/recovery/consent credential. Such a caller remains anonymous to the backend authorization system and gets only the explicitly restricted operation.',
    'visitor_session': 'A valid necessary chat visitor cookie. It authorizes only conversations owned by that cookie, never any backend account privilege.',
    'authenticated_self': 'A valid current backend account/device acting on its own account. All ADMIN, SALES, and EDITOR accounts may use self-account functions; no ADMIN-only or SALES-only business authorization is implied.',
    'EDITOR': 'A current valid backend EDITOR; public traffic/product/3D aggregates only, no shared chat or system sources.',
    'SALES': 'A current valid backend SALES; shared human chat inbox, traffic/3D and inquiry counts under the existing sales scope. No system sources.',
    'ADMIN': 'A current valid backend ADMIN, full authorized administration subject to fresh-grant and target restrictions.',
    'cron': 'A controlled server job or reporting script authenticated by the dedicated Bearer CRON_SECRET. A browser session, including ADMIN, cannot substitute for that secret.',
    'public': 'No authentication or endpoint-specific credential is required; same-origin checks and rate limiting may still apply.',
}

auth_protocol = 'Keep the existing Auth.js protocol, not a unified JSON success envelope: CSRF, redirect, cookie, CredentialsSignin, and session shapes remain Auth.js-owned. Sign-in uses POST and same-origin/CSRF checks; GET session reads session or null and does not extend real-activity time. Successful routine credentials verification creates a new AdminDeviceSession transactionally. A normal signOut revokes its sid on the server. Password+totp or, only for enabled and already enrolled valid accounts, email+totp is permitted; recovery codes are excluded. All sign-in failures remain the generic Auth.js failure and cannot enumerate accounts or sign-in modes. The client cannot submit role/sid/sv/remembered through session.update.'
fresh = 'Fresh grants require the current password and an unused TOTP from the actual current secret and step. Grants are single-use, five minutes, bound to user/device/sv/purpose/target; consumption and the final sensitive action occur in one transaction with a current User+Device+Grant recheck. A backend session or TOTP alone cannot authorize these operations.'
enrollment = 'This is initial binding using the existing email/password/token protocol, not an existing backend session requirement. Require the one-time current enrollment token, the earlier of the existing 24h/72h windows, a 10-minute pending binding, and at most five wrong codes. Final enroll/confirm CAS must recheck current token hash, expiry, sv, and secret. Restricted binding is not a backend role grant.'
restricted = 'This is an anonymous caller holding an endpoint-specific restricted recovery credential, not a normal authenticated backend session and not visitor_session. Its dedicated cookie is Secure/HttpOnly/SameSite=Strict/Path=/api/auth-admin/recovery with no Domain, stores a hash server-side, lasts ten minutes, and is accepted only by recovery/enroll and recovery/confirm. These writes require exact Origin. It has no ADMIN/SALES/EDITOR privilege and cannot become a backend session through a callback URL.'
chat_visitor = 'The necessary visitor cookie is Secure/HttpOnly/SameSite=Lax/Path=/api/chat with no Domain, generated only on active contact. It is distinct from analytics consent and backend Auth.js. Server authorization is based on the actual cookie, never an ID in the request; random conversation IDs are not authorization. Seven-day idle and thirty-day absolute expiry. Polling/read markers do not extend activity. Exact Origin and no cross-site credentialed CORS.'
chat_dedup = 'Bind UUID keys to the real visitor/operator identity and conversation. The database unique constraint plus payload hash is final deduplication: identical key and payload returns the same message id/seq, different payload returns 409, and a duplicate cannot create another notification. Return received only after the conversation/message/outbox transaction commits. A saved message or operator reply advances the 90-day retention activity; polling/read/notification does not. Anonymized conversations cannot be resumed.'
chat_ops = 'ADMIN and SALES share the human chat inbox. EDITOR cannot access it. Backend chat authorization uses a currently valid Auth.js account and device; message author and own read cursor come from that current session, not from client-supplied user IDs. This does not change the existing SALES inquiry assignment scope.'
jobs = 'Only fixed registry jobs exist: chat-notifications, analytics-aggregate, analytics-retention, chat-retention, ops-sample; the existing mail queue remains separate. A current 90-second CAS lease rejects overlap; per-run maximum 55 seconds and batches at most 500. SMTP is outside the database transaction; stableMessageId and lease generation fence retries. Unknown delivery may produce duplicates under bounded at-least-once retry. Retention must remain dry-run until explicitly authorized for production. No arbitrary task creation, path, or code execution.'

contexts = {
1: auth_protocol,
2: auth_protocol,
3: enrollment,
4: enrollment + ' Confirm verifies a new TOTP against the current pending secret and unused actual step, atomically enables it, and returns recovery codes once.',
5: fresh + ' Increment sv and revoke every device atomically, audit safely, then require sign-in again. The old protocol remains compatible.',
6: fresh + ' This known-password self-reenrollment can create a SELF_REAUTH restricted recovery session. The old effective TOTP/password/default mode remains until a new TOTP is confirmed atomically; no direct clearing of the old factor. The existing enrollLink points to the restricted page.',
7: fresh + ' Only a fresh ADMIN authorizing a different target may issue the fifteen-minute one-time permit. It does not reset the target factor or create a target backend session. No body/no-verification legacy bypass remains.',
8: 'Read only the current effective backend account and its coarse device summary; no action on another user. Current User role is read on every request rather than trusting an old JWT role. Do not return device revocation credentials.',
9: 'Only actual foreground mouse/keyboard/route activity triggers this, throttled to fifteen minutes. First verify device is unexpired, then CAS lastActivityAt and write the new JWT/cookie into the actual Response. Ordinary idle is two hours; remembered idle is seven days with a thirty-day absolute cap. Equality at an expiry boundary is invalid. Polling/auth()/session reads are not activity.',
10: fresh + ' purpose LOGIN_MODE/PASSWORD/TOTP_RESET/RECOVERY_AUTHORIZE/DEVICE_REVOKE/LOGOUT_ALL; the target is the relevant user/device or self. RECOVERY_AUTHORIZE additionally requires ADMIN and forbids self-targeting. Return the random grant once, keep only its hash, and do not log the secret.',
11: fresh + ' Enabling is only for the account owner with a current confirmed TOTP. Disabling does not delete TOTP. Revoke old sessions on successful mode change and sign in again.',
12: 'Read only the current backend account own device sessions; random device IDs do not grant access. The session summary cannot reveal a revocation credential.',
13: fresh + ' Only a device owned by the current account can be revoked, including the current sid. The revocation result is idempotent, but grant consumption must not be automatically retried.',
14: fresh + ' Under a User row lock, increment sessionVersion and revoke all device sessions atomically, then clear the Auth.js cookie. One-time grant consumption must not be automatically retried.',
15: fresh + ' The current valid ADMIN must authorize a different target. Issue only a fifteen-minute one-time restricted permit, never a target backend session. Return its secret once; only a separately OS-authorized local SERVER_OWNER CLI may preauthorize pendingPasswordHash, never this HTTP endpoint.',
16: restricted + ' This start endpoint accepts a valid unused recovery code or a valid unused target-bound permit plus email instead of any backend session. Lock the User, reread and consume exactly the matching current credential, increment sv, revoke devices and old recovery sessions, preserve effective TOTP/password/default mode, clear invalid temporary binding state, create the restricted session, and audit in one transaction. A repeated credential cannot create a second session. A lost response requires a new credential; never return the previous secret.',
17: restricted + ' Generate a new encrypted pendingSecret for RESTRICTED -> ENROLLING. Preserve the original effective factor/password/default mode until final confirmation. Failure/expiry revokes restricted state; no binding bypass.',
18: restricted + ' Confirm only a new TOTP, never password/newPassword/passwordHash. Match current recovery session/token hash/sv/pending secret/expiry and an unused actual TOTP step. Atomically publish the new secret and replacement recovery-code hashes, increment sv, revoke concurrent devices, consume the restricted session and cookie, audit, and return recovery codes once. Only an existing SERVER_OWNER local preauthorization may atomically replace passwordHash. Preserve passwordlessEnabled, then require normal sign-in after the next TOTP step; do not issue a backend session.',
19: chat_visitor + ' With a valid cookie session creation is idempotent. Without a cookie, a network retry can create an empty session that expires by TTL; a client bootstrap key cannot recover authorization. Active opening may touch idle activity only if the session is still valid.',
20: chat_visitor + ' ' + chat_dedup,
21: chat_visitor + ' Read only the cookie-owned conversation; CLOSED remains readable. Return messages in ascending seq, then advance the client cursor only after complete pagination. A missing gap or a cursor past lastSeq requires a fresh snapshot. No read-side touch or notification.',
22: chat_visitor + ' ' + chat_dedup + ' CLOSED yields conversation_closed. Only OPEN can receive a message.',
23: chat_visitor + ' Only update that visitor own conversation read cursor using MAX/CAS to an already existing seq at or below lastSeq. It cannot move backward or affect another account cursor and does not touch activity.',
24: chat_ops + ' A stable full-page inbox snapshot sorted by updatedAt/id; current operator unread totals use only that operator cursor. Do not treat a global incrementing ID as a committed increment stream.',
25: chat_ops + ' Read authorized message bodies in ascending conversation seq only. CLOSED is still readable. Never return the visitor secret cookie/token. No status writes, activity touches, or notifications.',
26: chat_ops + ' ' + chat_dedup + ' Only OPEN conversations accept the operator reply.',
27: chat_ops + ' Use MAX/CAS only for the current operator own cursor and only to an existing seq at or below lastSeq. No cursor rollback or other user update. This does not advance conversation retention activity.',
28: chat_ops + ' Only explicit OPEN -> CLOSED. Compare expectedVersion with the current version; mismatch is 409 without overwrite. A repeat for the same target version may return current state. CLOSED is readable and rejects new writes; a visitor may actively start a new consultation.',
29: 'Anonymous same-origin consent operation independent of the necessary chat cookie. Use the existing pj-consent UI. Only explicit analytics consent generates a random browser ID and signs the pj_analytics cookie with consentVersion/grantedAt/expiry, at most one year. Withdrawal clears the cookie, stops collection, and clears locally queued events. Renewed consent creates a new ID. No browser ID to third parties, no tracking those who decline, no login requirement.',
30: 'Anonymous analytics caller must carry a server-verified signed and unexpired consent cookie; no backend session is required. Server derives a domain-separated browserHash, never trusts consent=true or a browserId in the body. kinds: page_view/product_view/model_view_start/model_load_success/model_load_failure/chat_start. eventId and semanticKey are both unique with payload hashes; identical retries are duplicates and cannot recount, conflicts 409. Semantic keys bind browser hash and kind/navigation/product or viewId; one terminal result per viewId and only terminal events with a corresponding start count. Verify published product slug, sanitize path to an internal allowlisted path without query/hash, accept occurredAt only now-48h through now+5min. No IP/UA raw data, email, message body, full URLs, stack, or fingerprint.',
31: 'Read only analytics.settings; ADMIN only. Default UTC/revision 1. No data collection or rebuild is triggered by GET.',
32: 'ADMIN only, exact Origin. Validate a supported IANA timezone. Compare expectedVersion using the existing setting row lock/CAS; record the new timezone revision and rebuild todo plus audit atomically. Preserve old aggregates with their original revision. Only full raw-data days within retention are recomputable, otherwise report partial/unavailable; do not mix revisions or invent zero.',
33: 'Read-only dashboard. ADMIN may request traffic/3D/inquiries/chat/API errors/mail/storage/backup. SALES may request traffic/3D, inquiry counts under existing sales scope, and shared chat counts. EDITOR may request only public traffic and product/3D aggregates. Apply role/source filters server-side before querying; lower-privilege DTOs omit hidden sources and counts, and direct requests for system sources return 403. Inquiry counts come from Inquiry under scope, chat from ChatConversation/ChatMessage/ChatNotification, mail from MailMessage and actual outbox state, traffic from AnalyticsDaily and real aggregation state. API coverage is only the newly wired API final-response counters, never a claimed whole-site error rate. Storage/backup are controlled reports containing only metrics and real completion/verification times, not paths or contents. Per-source states are ok/zero/no_data/not_connected/query_failed/stale with value number/null, timezone/revision, dataThrough, queriedAt, lastSucceededAt, coverage. A failed source is not zero and does not block other sources. GET never writes state, collects data, sends mail, or runs backup.',
34: jobs,
35: jobs + ' This legacy GET is a mail-queue worker trigger, not a safe read. Preserve the existing feature-switch-first contract and stale/sent/failed/deferred/dropped counts. Add its actual every-minute OS cron call without removing existing cleanup/backup.',
36: jobs + ' Preserve the existing mail-queue protocol, feature-switch-first contract and stale/sent/failed/deferred/dropped counts. Add its actual every-minute OS cron call without removing existing cleanup/backup.',
37: 'Only controlled server reporting scripts authenticated with Bearer CRON_SECRET; no Auth.js session replacement and no caller-controlled filesystem path. source is STORAGE/BACKUP. Store only allowlisted bytesUsed/bytesFree or backupCompletedAt/backupAgeSeconds/verified and safe enum errors/times. Failed reports preserve the last successful values marked stale. No file names, host addresses, dump contents, secrets, or arbitrary values. Dashboard consumers remain read-only.',
}

doc_lines = (DOCS / '02-设计/10-接口约定.md').read_text(encoding='utf-8-sig').splitlines()
manifest = []
for index, (raw, en) in enumerate(zip(source, translations), 1):
    num = f'{index:02d}'
    endpoint = {'method': raw['method'], 'path': raw['path'], 'params': en[0], 'returns': en[1], 'permission': en[2]}
    state = {'endpoint': endpoint, 'roles': roles, 'role_definitions': role_definitions, 'contract_context': contexts[index]}
    assert not any('\u3400' <= c <= '\u9fff' for c in json.dumps(state, ensure_ascii=False))
    (OUT / f'{num}.state.json').write_text(json.dumps(state, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    table_line = next(i for i, line in enumerate(doc_lines, 1) if line.startswith('| ') and f'| {raw["path"]} |' in line)
    manifest.append({'index': index, 'method': raw['method'], 'path': raw['path'], 'source_table_line': table_line, 'state': f'{num}.state.json', 'log': f'{num}.jsonl', 'stdout': f'{num}.stdout.json', 'source': raw})

snapshots = {}
for relative in ['_run/endpoints-contract.json', '02-设计/10-接口约定.md', '02-设计/09-数据模型.md']:
    data = (DOCS / relative).read_bytes()
    destination = OUT / ('source-' + Path(relative).name)
    destination.write_bytes(data)
    snapshots[relative] = hashlib.sha256(data).hexdigest()
(OUT / 'manifest.json').write_text(json.dumps({'source_sha256': snapshots, 'endpoints': manifest}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(f'Prepared {len(manifest)} English endpoint states and public-spec snapshots.')
