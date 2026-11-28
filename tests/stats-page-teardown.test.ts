import assert from 'node:assert/strict';
import test from 'node:test';
import { closeRoutedContext } from '../e2e/fixtures';

test('a pending analytics receipt finishes before its browser context closes', async () => {
  let finishReceipt!: () => void;
  const receipt = new Promise<void>((resolve) => { finishReceipt = resolve; });
  const events: string[] = [];

  const closing = closeRoutedContext({
    async unrouteAll(options) {
      assert.equal(options?.behavior, 'wait');
      await receipt;
      events.push('receipt read');
    },
  }, {
    async close() { events.push('context closed'); },
  });

  assert.deepEqual(events, []);
  finishReceipt();
  await closing;
  assert.deepEqual(events, ['receipt read', 'context closed']);
});
