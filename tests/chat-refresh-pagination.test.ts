import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { contiguousMessageSeq, fetchChatConversationUpdates } from '../src/lib/client/chat';

test('a bounded visitor refresh keeps its received pages and resumes at the next message', async () => {
  const requested: number[] = [];
  const total = 51;
  const createdAt = '2026-01-01T00:00:00.000Z';
  const conversation = {
    id: 'thread', locale: 'en', status: 'OPEN', version: 1, productSlug: null, sourcePath: null,
    createdAt, updatedAt: createdAt, lastActivityAt: createdAt, retainUntil: '2026-04-01T00:00:00.000Z',
    anonymizedAt: null,
  };
  const transport = async (path: string) => {
    const cursor = Number(new URL(path, 'https://example.test').searchParams.get('afterSeq'));
    requested.push(cursor);
    const seq = cursor + 1;
    const id = `message-${seq}`;
    return Response.json({
      conversation, lastSeq: total, nextAfterSeq: seq, hasMore: seq < total, read: { lastReadSeq: 0 },
      messages: [{ id, seq, sender: 'OPERATOR', bodyText: `Reply ${seq}`, createdAt }],
      authors: [{ messageId: id, authorRef: 'operator' }],
    });
  };

  const options = { limit: 1, transport };
  const first = await fetchChatConversationUpdates(conversation.id, 0, 'en', options);
  assert.ok(first.ok, !first.ok ? first.text : undefined);
  assert.equal(first.data.nextAfterSeq, 50);
  assert.equal(contiguousMessageSeq(first.data.messages), 50);
  assert.deepEqual(first.data.authors.map(a => a.messageId), first.data.messages.map(m => m.id));

  const second = await fetchChatConversationUpdates(conversation.id, first.data.nextAfterSeq, 'en', options);
  assert.ok(second.ok);
  assert.deepEqual(second.data.messages.map(m => m.seq), [total]);
  assert.equal(second.data.authors[0]?.messageId, `message-${total}`);
  assert.deepEqual(requested, Array.from({ length: total }, (_, cursor) => cursor));
});
