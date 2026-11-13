import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { BgTaskSnapshot } from './common.ts';

export interface CompletionReceiptContext {
  sessionManager: Pick<ExtensionContext['sessionManager'], 'getSessionId' | 'getEntries'>;
  isIdle: ExtensionContext['isIdle'];
  hasPendingMessages: ExtensionContext['hasPendingMessages'];
}

/** Session history is the receipt; submitting to the host is not acknowledgement. */
export function completionDeliveryState(
  ctx: CompletionReceiptContext | undefined,
  task: Pick<BgTaskSnapshot, 'id' | 'ownerSession'>,
): 'delivered' | 'pending' | 'ready' {
  if (!ctx || !task.ownerSession || ctx.sessionManager.getSessionId() !== task.ownerSession) return 'pending';
  // Include abandoned branches: a branch change must not replay an observed event.
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== 'custom_message' || entry.customType !== 'background-task-notification') continue;
    const details: unknown = entry.details;
    if (typeof details !== 'object' || details === null || !('id' in details) || details.id !== task.id) continue;
    if ('ownerSession' in details && details.ownerSession !== undefined && details.ownerSession !== task.ownerSession) continue;
    return 'delivered';
  }
  // Avoid the host's volatile streaming queues. An idle send is still only an
  // attempt: triggerTurn preparation may fail before the message is recorded.
  return ctx.isIdle() && !ctx.hasPendingMessages() ? 'ready' : 'pending';
}
