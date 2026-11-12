import { after } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Each test-file process owns only the service at this unique root. */
const root = await mkdtemp(join(tmpdir(), 'pi-bg-test-service-'));
process.env['PI_BG_SERVICE_DIR'] = root;
after(async () => {
  const { rpc, endpoint } = await import('../../src/persistent/shared.mjs');
  try {
    const identity = await rpc(endpoint('daemon', root), 'ping', {}, root) as { pid: number; startToken: string };
    const confirmed = await rpc(endpoint('daemon', root), 'ping', {}, root) as { pid: number; startToken: string };
    if (identity.pid === confirmed.pid && identity.startToken && identity.startToken === confirmed.startToken) process.kill(identity.pid, 'SIGTERM');
  } catch { /* No owned daemon remains reachable. */ }
});
