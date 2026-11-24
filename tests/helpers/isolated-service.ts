import { after } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupServiceRoot } from './service-cleanup.mjs';

/** Each test-file process owns only the service at this unique root. */
const root = await mkdtemp(join(tmpdir(), 'pi-bg-test-service-'));
after(() => cleanupServiceRoot(root));
process.env['PI_BG_SERVICE_DIR'] = root;
