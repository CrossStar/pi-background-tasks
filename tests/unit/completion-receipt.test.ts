import { test } from 'node:test';
import assert from 'node:assert/strict';
import { completionDeliveryState, type CompletionReceiptContext } from '../../src/core/completion-receipt.ts';

test('completion receipts require exact session history and defer while busy or queued', () => {
  const task = { id: 'b-receipt', ownerSession: 'owner' };
  let entries: ReturnType<CompletionReceiptContext['sessionManager']['getEntries']> = [];
  let idle = true;
  let queued = false;
  const ctx: CompletionReceiptContext = {
    sessionManager: { getSessionId: () => 'owner', getEntries: () => entries },
    isIdle: () => idle, hasPendingMessages: () => queued,
  };
  assert.equal(completionDeliveryState(undefined, task), 'pending');
  assert.equal(completionDeliveryState(ctx, { ...task, ownerSession: 'foreign' }), 'pending');
  assert.equal(completionDeliveryState(ctx, { id: task.id }), 'pending');
  assert.equal(completionDeliveryState(ctx, task), 'ready');
  idle = false;
  assert.equal(completionDeliveryState(ctx, task), 'pending');
  idle = true; queued = true;
  assert.equal(completionDeliveryState(ctx, task), 'pending');
  const entry = { type: 'custom_message' as const, id: 'receipt', parentId: null,
    timestamp: new Date(0).toISOString(), customType: 'background-task-notification',
    content: 'done', details: { id: task.id, ownerSession: 'foreign' }, display: true };
  entries = [entry];
  assert.equal(completionDeliveryState(ctx, task), 'pending');
  entries = [{ ...entry, customType: 'unrelated', details: task }];
  assert.equal(completionDeliveryState(ctx, task), 'pending');
  entries = [{ ...entry, details: { id: 'another-task' } }];
  assert.equal(completionDeliveryState(ctx, task), 'pending');
  entries = [{ ...entry, details: { id: task.id } }];
  idle = false;
  assert.equal(completionDeliveryState(ctx, task), 'delivered');
});
