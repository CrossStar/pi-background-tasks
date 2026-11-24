import type { TaskRecord, TaskList } from '../../src/persistent/client.js';
import type { PersistentRemoteStart } from '../../src/core/execution-backend.js';
import { EventEmitter } from 'node:events';
import { BG_EXECUTION_CHANNEL, BG_EXECUTION_HOOK_CHANNEL } from '../../src/core/execution-backend.js';
import { describe, it, after, afterEach, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import {
  initTheme,
  ModelRuntime,
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type EventBus,
  type ExtensionUIContext,
} from '@earendil-works/pi-coding-agent';
import { parseJsonText, type BgTaskSnapshot, type TaskStatus } from '../../src/core/common.js';
import {
  BG_EXTENSION_CAPABILITIES,
  BG_REQUEST_CHANNEL,
  BG_REQUEST_SCHEMA,
  BG_RESPONSE_CHANNEL,
  BG_RESPONSE_SCHEMA,
  BG_TERMINAL_CHANNEL,
  BG_TERMINAL_SCHEMA,
  type BackgroundTaskExtensionResponse,
  type BackgroundTaskExtensionTerminal,
} from '../../src/core/extension-api.js';
import { parsePackageInfo } from '../../src/core/update-check.js';

const sdkServiceRoot = await mkdtemp(join(tmpdir(), 'pi-bg-sdk-service-'));
process.env['PI_BG_SERVICE_DIR'] = sdkServiceRoot;
after(async () => {
  const { rpc, endpoint } = await import('../../src/persistent/shared.mjs');
  try {
    const identity = await rpc(endpoint('daemon', sdkServiceRoot), 'ping', {}, sdkServiceRoot) as { pid: number; startToken: string };
    const confirmed = await rpc(endpoint('daemon', sdkServiceRoot), 'ping', {}, sdkServiceRoot) as { pid: number; startToken: string };
    if (identity.pid === confirmed.pid && identity.startToken && identity.startToken === confirmed.startToken) process.kill(identity.pid, 'SIGTERM');
  } catch { /* No daemon was started, or it already exited. */ }
});
const extensionPath = resolve('extensions/background-tasks.ts');
const scriptedProviderPath = resolve('tests/scripted-provider/scripted-provider-extension.ts');
const roots: string[] = [];

function skipWin32PiPathFixture(t: TestContext, target: string): boolean {
  if (process.platform !== 'win32') return false;
  t.skip(
    `${target} fake Pi PATH interception is not applicable on win32 because production resolves the Pi package instead of PATH by design`,
  );
  return true;
}

function skipWin32PosixPiTelemetry(t: TestContext): boolean {
  if (process.platform !== 'win32') return false;
  t.skip('POSIX-shell Pi telemetry wrapping is not applicable on win32 cmd tasks by design');
  return true;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function resolvePiCli(): string | undefined {
  const which = spawnSync('bash', ['-lc', 'command -v pi'], { encoding: 'utf8' });
  return which.status === 0 ? which.stdout.trim() || undefined : undefined;
}

interface SdkHarnessOptions {
  cwd?: string;
  sessionManager?: SessionManager;
  eventBus?: EventBus | undefined;
}

async function harness(options: SdkHarnessOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pi-bg-sdk-'));
  roots.push(root);
  const cwd = options.cwd ?? join(root, 'project');
  const agentDir = join(root, 'agent');
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    additionalExtensionPaths: [extensionPath],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
    noThemes: true,
    ...(options.eventBus === undefined ? {} : { eventBus: options.eventBus }),
  });
  await loader.reload();
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: null,
  });
  const modelRegistry = new ModelRegistry(modelRuntime);
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    resourceLoader: loader,
    sessionManager: options.sessionManager ?? SessionManager.inMemory(cwd),
    settingsManager,
    modelRuntime,
    noTools: 'builtin',
  });
  return { session, cwd, modelRegistry, modelRuntime };
}

type JsonObject = Record<PropertyKey, unknown>;

interface TestToolContent {
  type: string;
  text?: string;
  [key: string]: unknown;
}

interface TestToolDetails extends JsonObject {
  task?: unknown;
  tasks?: unknown;
}

interface TestToolResult {
  content: TestToolContent[];
  details: TestToolDetails;
}

interface CustomNotificationEntry {
  type: 'custom_message';
  customType: string;
  content: string;
  details: JsonObject;
}

interface PreparedBgRunArgs extends JsonObject {
  name?: string;
  command?: string;
  isAgent: boolean;
}

interface UiNotification {
  message: string;
  type?: 'info' | 'warning' | 'error';
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return value === 'running' || value === 'completed' || value === 'failed' || value === 'killed';
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonObject(text: string, message: string): JsonObject {
  const parsed = parseJsonText(text);
  assert.ok(isJsonObject(parsed), message);
  return parsed;
}

function requiredJsonObject(value: unknown, message: string): JsonObject {
  assert.ok(isJsonObject(value), message);
  return value;
}

function isBgTaskSnapshot(value: unknown): value is BgTaskSnapshot {
  return (
    isJsonObject(value) &&
    typeof value['id'] === 'string' &&
    typeof value['command'] === 'string' &&
    isTaskStatus(value['status']) &&
    typeof value['outputPath'] === 'string' &&
    typeof value['cwd'] === 'string' &&
    typeof value['startTime'] === 'number' &&
    typeof value['bytesWritten'] === 'number' &&
    typeof value['isAgent'] === 'boolean' &&
    typeof value['notified'] === 'boolean' &&
    typeof value['notifyOnCompletion'] === 'boolean' &&
    typeof value['triggerOnCompletion'] === 'boolean'
  );
}

function isTestToolContent(value: unknown): value is TestToolContent {
  return isJsonObject(value) && typeof value['type'] === 'string';
}

function isTestToolResult(value: unknown): value is TestToolResult {
  return (
    isJsonObject(value) &&
    Array.isArray(value['content']) &&
    value['content'].every(isTestToolContent) &&
    isJsonObject(value['details'])
  );
}

function isCustomNotificationEntry(value: unknown): value is CustomNotificationEntry {
  return (
    isJsonObject(value) &&
    value['type'] === 'custom_message' &&
    value['customType'] === 'background-task-notification' &&
    typeof value['content'] === 'string' &&
    isJsonObject(value['details'])
  );
}

function isPreparedBgRunArgs(value: unknown): value is PreparedBgRunArgs {
  return (
    isJsonObject(value) &&
    typeof value['isAgent'] === 'boolean' &&
    (value['name'] === undefined || typeof value['name'] === 'string') &&
    (value['command'] === undefined || typeof value['command'] === 'string')
  );
}

function requiredTask(value: unknown, message: string): BgTaskSnapshot {
  assert.ok(isBgTaskSnapshot(value), message);
  return value;
}

function taskFromResult(result: TestToolResult): BgTaskSnapshot {
  return requiredTask(result.details.task, 'tool result should include a background task snapshot');
}

function tasksFromResult(result: TestToolResult): BgTaskSnapshot[] {
  const tasks = result.details.tasks;
  assert.ok(Array.isArray(tasks), 'tool result should include a task list');
  return tasks.map((task) =>
    requiredTask(task, 'task list entry should be a background task snapshot'),
  );
}

function firstTask(result: TestToolResult): BgTaskSnapshot {
  const task = tasksFromResult(result)[0];
  assert.ok(task, 'tool result should include at least one background task snapshot');
  return task;
}

function resultText(result: TestToolResult): string {
  const content = result.content[0];
  assert.ok(content, 'tool result should include a content item');
  if (typeof content.text !== 'string') {
    throw new Error('tool result first content item should include text');
  }
  return content.text;
}

function requiredPrepared(value: unknown): PreparedBgRunArgs {
  assert.ok(
    isPreparedBgRunArgs(value),
    'prepared bg_run arguments should satisfy the bg_run schema',
  );
  return value;
}

async function exec(session: AgentSession, name: string, params: unknown): Promise<TestToolResult> {
  const tool = session.getToolDefinition(name);
  assert.ok(tool, `missing tool ${name}`);
  const result: unknown = await tool.execute(
    `call-${name}`,
    params,
    undefined,
    undefined,
    session.extensionRunner.createContext(),
  );
  assert.ok(isTestToolResult(result), `${name} should return a tool result object`);
  return result;
}

async function wait(session: AgentSession, id: string, iterations = 100): Promise<BgTaskSnapshot> {
  for (let i = 0; i < iterations; i++) {
    const s = await exec(session, 'bg_status', { taskId: id });
    const t = firstTask(s);
    if (t.status !== 'running') return t;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timeout');
}

function customNotifications(session: AgentSession): CustomNotificationEntry[] {
  const entries: readonly unknown[] = session.sessionManager.getEntries();
  return entries.filter(isCustomNotificationEntry);
}

async function waitForNotification(session: AgentSession, id: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (customNotifications(session).some(entry => entry.details['id'] === id)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(`missing terminal notification for ${id}`);
}

async function readJsonEventually(path: string): Promise<JsonObject> {
  let last = '';
  for (let i = 0; i < 20; i++) {
    last = await readFile(path, 'utf8').catch(() => '');
    if (last.trim()) return parseJsonObject(last, 'metadata JSON should be an object');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return parseJsonObject(last, 'metadata JSON should be an object');
}

async function readJsonWithStatus(path: string, status: string): Promise<JsonObject> {
  let metadata = await readJsonEventually(path);
  for (let attempt = 0; attempt < 40; attempt++) {
    metadata = await readJsonEventually(path);
    if (metadata['status'] === status) return metadata;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return metadata;
}

function requireEventResponse(value: unknown): BackgroundTaskExtensionResponse {
  assert.ok(isJsonObject(value), 'EventBus response must be an object');
  assert.equal(value['schema_version'], BG_RESPONSE_SCHEMA);
  assert.equal(typeof value['request_id'], 'string');
  assert.equal(typeof value['operation'], 'string');
  assert.equal(typeof value['ok'], 'boolean');
  const hasResult = Object.prototype.hasOwnProperty.call(value, 'result');
  const hasError = Object.prototype.hasOwnProperty.call(value, 'error');
  assert.notEqual(
    hasResult,
    hasError,
    'EventBus response must contain exactly one of result/error',
  );
  return value as BackgroundTaskExtensionResponse;
}

function requireOkResult(response: BackgroundTaskExtensionResponse): unknown {
  assert.equal(response.ok, true, response.ok ? 'ok' : response.error);
  return response.ok ? response.result : undefined;
}

function requireTerminal(value: unknown): BackgroundTaskExtensionTerminal {
  assert.ok(isJsonObject(value), 'EventBus terminal must be an object');
  assert.deepEqual(Object.keys(value).sort(), ['schema_version', 'task']);
  assert.equal(value['schema_version'], BG_TERMINAL_SCHEMA);
  return { schema_version: BG_TERMINAL_SCHEMA, task: requiredTask(value['task'], 'terminal task') };
}

// The EventBus kill response is only emitted after stopTask resolves. On Windows
// the two-stage taskkill flow issues a logical terminate request first and waits
// the full KILL_GRACE_MS window (3000 ms) before forcing, so a kill response
// cannot arrive inside the POSIX budget. POSIX keeps the tight budget so a
// genuine hang still fails fast there.
const EVENT_RESPONSE_TIMEOUT_MS = process.platform === 'win32' ? 10_000 : 1500;

function waitForEventResponse(
  eventBus: EventBus,
  requestId: string,
): Promise<BackgroundTaskExtensionResponse> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timed out waiting for EventBus response ${requestId}`));
    }, EVENT_RESPONSE_TIMEOUT_MS);
    const unsubscribe = eventBus.on(BG_RESPONSE_CHANNEL, (data) => {
      const response = requireEventResponse(data);
      if (response.request_id !== requestId) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve(response);
    });
  });
}

async function emitEventRequest(
  eventBus: EventBus,
  requestId: string,
  operation: string,
  payload: Record<string, unknown>,
): Promise<BackgroundTaskExtensionResponse> {
  const pending = waitForEventResponse(eventBus, requestId);
  eventBus.emit(BG_REQUEST_CHANNEL, {
    schema_version: BG_REQUEST_SCHEMA,
    request_id: requestId,
    operation,
    payload,
  });
  return pending;
}

// Matches EVENT_RESPONSE_TIMEOUT_MS: a killed task only reaches a terminal state
// after the Windows grace window elapses, so the same platform budget applies.
const TERMINAL_SNAPSHOT_POLL_MS = 25;
const TERMINAL_SNAPSHOT_ATTEMPTS = EVENT_RESPONSE_TIMEOUT_MS / TERMINAL_SNAPSHOT_POLL_MS;

async function waitForTerminalSnapshot(
  terminals: readonly BgTaskSnapshot[],
  taskId: string,
): Promise<BgTaskSnapshot> {
  for (let attempt = 0; attempt < TERMINAL_SNAPSHOT_ATTEMPTS; attempt++) {
    const terminal = terminals.find((task) => task.id === taskId);
    if (terminal) return terminal;
    await new Promise((resolve) => setTimeout(resolve, TERMINAL_SNAPSHOT_POLL_MS));
  }
  throw new Error(`timed out waiting for terminal ${taskId}`);
}

async function cleanupRoot(root: string): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rm(root, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!(error instanceof Error) || !/ENOTEMPTY/.test(error.message) || attempt === 4)
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

afterEach(async () => {
  for (const r of roots.splice(0)) await cleanupRoot(r);
});

function makeStatusUi(
  baseUi: ExtensionUIContext,
  statuses: Array<string | undefined>,
  notifications: UiNotification[],
): ExtensionUIContext {
  initTheme('dark');
  return {
    ...baseUi,
    notify: (message, type) => {
      const notification: UiNotification = { message };
      if (type !== undefined) notification.type = type;
      notifications.push(notification);
    },
    setStatus: (_key, text) => {
      statuses.push(text);
    },
  };
}

async function startRegistry(
  payload: string,
  status = 200,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(payload);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const address = server.address();
  assert.ok(
    address !== null && typeof address === 'object',
    'registry server must report an address',
  );
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

async function renderFooterViaJobs(session: AgentSession): Promise<void> {
  const jobs = session.extensionRunner
    .getRegisteredCommands()
    .find((cmd) => cmd.invocationName === 'jobs');
  assert.ok(jobs);
  await jobs.handler('', session.extensionRunner.createCommandContext());
}

const UPDATE_ENV_KEYS = ['PI_OFFLINE', 'PI_BG_DISABLE_UPDATE_CHECK', 'PI_BG_REGISTRY_URL'] as const;

type EnvOverrides = Record<string, string>;

interface SettledFooterOptions {
  env: EnvOverrides;
  registryPayload: string;
  registryStatus?: number;
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

async function initCleanGit(cwd: string): Promise<void> {
  git(cwd, ['init']);
  git(cwd, ['config', 'user.email', 'pi-bg@example.invalid']);
  git(cwd, ['config', 'user.name', 'Pi BG Tests']);
  await writeFile(join(cwd, 'README.md'), 'clean\n', 'utf8');
  await writeFile(join(cwd, '.gitignore'), '.pi/\nbin/\nreport.md\n', 'utf8');
  git(cwd, ['add', 'README.md', '.gitignore']);
  git(cwd, ['commit', '-m', 'init']);
}

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
    return;
  }
  process.env[key] = value;
}

async function settledFooter(
  options: SettledFooterOptions,
): Promise<{ status: string | undefined; threw: boolean }> {
  const saved = new Map<string, string | undefined>();
  for (const key of UPDATE_ENV_KEYS) {
    saved.set(key, process.env[key]);
    restoreEnvValue(key, undefined);
  }
  for (const [key, value] of Object.entries(options.env)) process.env[key] = value;
  const registry = await startRegistry(options.registryPayload, options.registryStatus);
  process.env['PI_BG_REGISTRY_URL'] = registry.url;
  const { session } = await harness();
  const statuses: Array<string | undefined> = [];
  const notifications: UiNotification[] = [];
  session.extensionRunner.setUIContext(
    makeStatusUi(session.extensionRunner.getUIContext(), statuses, notifications),
  );
  let threw = false;
  try {
    await session.extensionRunner.emit({ type: 'session_start', reason: 'startup' });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await renderFooterViaJobs(session);
  } catch {
    threw = true;
  } finally {
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    session.dispose();
    await registry.close();
    for (const key of UPDATE_ENV_KEYS) {
      restoreEnvValue(key, saved.get(key));
    }
  }
  return { status: statuses.at(-1), threw };
}

void describe('sdk', () => {
  void it('bg_forget requires an exact ID, retains logs and unrelated tasks, and persists across reload', async () => {
    const eventBus = createEventBus();
    const records = new Map<string, TaskRecord>();
    let cancelCalls = 0;
    let listCalls = 0;
    const output = 'retained fake remote output\n';
    const get = async (id: string) => {
      const record = records.get(id);
      assert.ok(record, `Unknown fake task ${id}`);
      return record;
    };
    const unsubscribe = eventBus.on(BG_EXECUTION_CHANNEL, (request: unknown) => {
      assert.ok(isJsonObject(request));
      request['provider'] = {
        id: 'ssh:sdk-forget-fake', cwd: '/fake/remote',
        spawn: () => { throw new Error('Fake persistent provider must never spawn'); },
        persistent: {
          start: async (request: PersistentRemoteStart) => {
            const record: TaskRecord = {
              id: request.id, cwd: request.cwd,
              ...(request.ownerSession === undefined ? {} : { ownerSession: request.ownerSession }),
              name: request.name, command: request.command,
              status: 'running', startedAt: Date.now(),
              ...(request.description === undefined ? {} : { description: request.description }),
              ...(request.notifyOnCompletion === undefined ? {} : { notifyOnCompletion: request.notifyOnCompletion }),
              ...(request.triggerOnCompletion === undefined ? {} : { triggerOnCompletion: request.triggerOnCompletion }),
              outputFile: `/fake/remote/${request.id}.log`, outputBytes: Buffer.byteLength(output),
            };
            records.set(record.id, record);
            return record;
          },
          get,
          list: async () => {
            listCalls++;
            return Object.assign([...records.values()], { diagnostics: [] }) as TaskList;
          },
          cancel: async (id: string) => { cancelCalls++; return get(id); },
          logs: async (_id: string, offset: number, maxBytes: number) => {
            const bytes = Buffer.from(output).subarray(offset, offset + maxBytes);
            return { data: bytes.toString('base64'), nextOffset: offset + bytes.length, eof: true, size: Buffer.byteLength(output) };
          },
        },
      };
    });
    const { session } = await harness({ eventBus });
    const notifications: UiNotification[] = [];
    await session.bindExtensions({
      uiContext: makeStatusUi(session.extensionRunner.getUIContext(), [], notifications),
    });
    try {
      const command = session.extensionRunner.getRegisteredCommands().find(cmd => cmd.invocationName === 'bg_forget');
      assert.ok(command, '/bg_forget is registered as a command');
      assert.equal(session.getToolDefinition('bg_forget'), undefined);
      const launch = async (name: string) => taskFromResult(await exec(session, 'bg_run', {
        name, command: 'fake-only-command', isAgent: false,
        notifyOnCompletion: false, triggerOnCompletion: false,
      }));
      const forgotten = await launch('Forget this monitor');
      const retained = await launch('Keep this monitor');
      const ids = async () => tasksFromResult(await exec(session, 'bg_status', {})).map(task => task.id).sort();
      const before = await ids();
      for (const invalid of ['', forgotten.id.slice(0, -1), `${forgotten.id} ${retained.id}`, 'nonexistent-exact-id']) {
        notifications.length = 0;
        await command.handler(invalid, session.extensionRunner.createCommandContext());
        assert.deepEqual(await ids(), before, `Invalid argument must not forget: ${invalid}`);
        assert.ok(notifications.some(item => item.type === 'error' || item.type === 'warning'), 'Invalid arguments produce a diagnostic');
      }
      const savedOutput = await readFile(forgotten.outputPath, 'utf8');
      notifications.length = 0;
      await command.handler(forgotten.id, session.extensionRunner.createCommandContext());
      assert.deepEqual(await ids(), [retained.id]);
      const message = notifications.map(item => item.message).join('\n');
      assert.match(message, /remote/i);
      assert.match(message, /does not stop|not (?:been )?(?:stopped|cancelled|canceled)|continues|still running/i);
      assert.match(message, /logs?.*(?:retain|kept|preserv)|(?:retain|kept|preserv).*logs?/i);
      assert.equal(await readFile(forgotten.outputPath, 'utf8'), savedOutput);
      assert.equal(records.get(forgotten.id)?.status, 'running');
      const listsBefore = listCalls;
      await session.reload();
      assert.ok(listCalls > listsBefore, 'Reload rediscovers the fake provider records');
      assert.deepEqual(await ids(), [retained.id]);
      assert.equal(await readFile(forgotten.outputPath, 'utf8'), savedOutput);
      assert.equal(cancelCalls, 0);
    } finally {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
      unsubscribe();
      assert.equal(cancelCalls, 0, 'Forgetting, reload, and shutdown never cancel remote work');
    }
  });

  void it('deduplicates remote restore diagnostics without printing Error stacks', async () => {
    const eventBus = createEventBus();
    const { session } = await harness({ eventBus });
    await session.extensionRunner.emit({ type: 'session_start', reason: 'startup' });
    const messages: unknown[][] = [];
    const originalError = console.error;
    const fail = async () => { throw new Error('bootstrap exit 1: unsafe permissions'); };
    const unsubscribe = eventBus.on(BG_EXECUTION_CHANNEL, (request: unknown) => {
      assert.ok(isJsonObject(request));
      request['provider'] = { id: 'ssh:restore-test', cwd: '/remote', spawn: () => { throw Error('no spawn'); }, persistent: { start: fail, get: fail, list: fail, cancel: fail, logs: fail } };
    });
    try {
      console.error = (...args: unknown[]) => { messages.push(args); };
      for (let index = 0; index < 2; index++) {
        eventBus.emit('sydney-kit:bg-persistent-ready:v1', {});
        await new Promise(resolve => setImmediate(resolve));
      }
      assert.equal(messages.length, 1);
      assert.deepEqual(messages[0], ['Remote persistent restore failed: bootstrap exit 1: unsafe permissions']);
    } finally {
      console.error = originalError;
      unsubscribe();
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
    }
  });

  void it('discovers native execution providers synchronously and rejects agent bypasses', async () => {
    const eventBus = createEventBus();
    let spawns = 0;
    let disposals = 0;
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(), stderr: new EventEmitter(),
      kill: () => true,
      dispose: () => { disposals++; },
    });
    const unsubscribe = eventBus.on(BG_EXECUTION_CHANNEL, (request: unknown) => {
      assert.ok(isJsonObject(request));
      request['provider'] = { id: 'ssh:test', cwd: '/remote/captured', spawn: () => { spawns++; return child; } };
    });
    const { session, cwd } = await harness({ eventBus });
    try {
      const probe = { available: false };
      eventBus.emit(BG_EXECUTION_HOOK_CHANNEL, probe);
      assert.equal(probe.available, true);
      const result = await exec(session, 'bg_run', { name: 'Remote SDK', command: 'remote-only-command', isAgent: false, notifyOnCompletion: false });
      child.stdout.emit('data', 'remote-output\n');
      child.emit('close', 0, null);
      const task = await wait(session, taskFromResult(result).id);
      assert.equal(task.status, 'completed');
      assert.deepEqual(task.execution, { kind: 'external', id: 'ssh:test', cwd: '/remote/captured' });
      assert.match(await readFile(join(cwd, task.outputPath), 'utf8'), /remote-output/);
      await assert.rejects(() => exec(session, 'bg_run', { name: 'Agent', command: 'anything', isAgent: true }), /isAgent:false/);
      await assert.rejects(() => exec(session, 'bg_run_pi_attested', { name: 'Attested', provider: 'test', model: 'test', prompt: 'test', reportPath: 'out.md' }), /local execution/);
      const response = await emitEventRequest(eventBus, 'external-agent', 'run', { name: 'Agent', command: 'anything', isAgent: true, notifyOnCompletion: false, triggerOnCompletion: false });
      assert.equal(response.ok, false);
      assert.equal(spawns, 1);
      assert.equal(disposals, 1);
      const conflict = eventBus.on(BG_EXECUTION_CHANNEL, (request: unknown) => {
        assert.ok(isJsonObject(request));
        request['provider'] = { spawn: () => child };
      });
      try {
        await assert.rejects(() => exec(session, 'bg_run', { name: 'Conflict', command: 'anything', isAgent: false }), /Multiple background/);
      } finally { conflict(); }
    } finally {
      unsubscribe();
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      const probe = { available: false };
      eventBus.emit(BG_EXECUTION_HOOK_CHANNEL, probe);
      assert.equal(probe.available, false);
      session.dispose();
    }
  });

  void it('registers commands, tools, shortcuts, renderers, and runs with output and metadata files', async () => {
    const { session, cwd } = await harness();
    try {
      const retainedTools = ['bg_run', 'bg_run_pi_attested', 'bg_status', 'bg_logs', 'bg_kill'];
      assert.deepEqual(
        session.getActiveToolNames().filter((name) => name.startsWith('bg_') || name.startsWith('fusion_')).sort(),
        retainedTools.sort(),
      );
      for (const removed of ['bg_delegate', 'bg_result', 'fusion_reason', 'fusion_investigate', 'fusion_research', 'fusion_validate']) {
        assert.equal(session.getToolDefinition(removed), undefined, removed);
      }
      const bgRunTool = session.getToolDefinition('bg_run');
      assert.ok(bgRunTool, 'bg_run tool should be registered');
      const bgRunParams: unknown = bgRunTool.parameters;
      assert.ok(isJsonObject(bgRunParams), 'bg_run schema should be an object');
      const required = bgRunParams['required'];
      assert.ok(
        required === undefined || (Array.isArray(required) && !required.includes('isAgent')),
        'Slurm attachments must not require shell-only isAgent',
      );
      const properties = bgRunParams['properties'];
      const isAgentSchema = isJsonObject(properties) ? properties['isAgent'] : bgRunParams;
      assert.match(JSON.stringify(isAgentSchema), /LLM\/agent/);
      const cmds = session.extensionRunner.getRegisteredCommands().map((c) => c.invocationName);
      assert.deepEqual([...cmds].sort(), [
        'bg', 'jobs', 'logs', 'kill', 'tasks', 'bg-tasks', 'bg-clear', 'bg-update', 'bg_forget',
      ].sort());
      assert.equal(cmds.includes('fusion'), false);
      assert.equal(cmds.includes('fusion-models'), false);
      assert.ok(session.extensionRunner.getMessageRenderer('background-task-notification'));
      const shortcuts = session.extensionRunner.getShortcuts({});
      assert.ok(shortcuts.has('shift+down'));
      assert.ok(shortcuts.has('ctrl+alt+c'));

      const r = await exec(session, 'bg_run', {
        isAgent: false,
        name: 'SDK Echo',
        command: 'echo sdk-ok',
        notifyOnCompletion: false,
        triggerOnCompletion: false,
      });
      const t = await wait(session, taskFromResult(r).id);
      assert.equal(t.status, 'completed', await readFile(resolve(cwd, t.outputPath), 'utf8'));
      assert.equal(t.name, 'SDK Echo');
      assert.equal(t.isAgent, false);
      assert.equal(t.lifetime, 'persistent');
      assert.ok(existsSync(resolve(cwd, t.outputPath)));
      const metadataPath = join(dirname(resolve(cwd, t.outputPath)), 'record.json');
      assert.ok(existsSync(metadataPath));
      const metadata = await readJsonWithStatus(metadataPath, 'completed');
      assert.equal(metadata['status'], 'completed');
      assert.equal(metadata['name'], 'SDK Echo');
      assert.equal(metadata['outputFile'], t.outputPath);
      const logs = await exec(session, 'bg_logs', { taskId: t.id, maxBytes: 100 });
      assert.match(resultText(logs), /sdk-ok/);
      await assert.rejects(() => exec(session, 'bg_kill', { taskId: t.id }), /not running/);
    } finally {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
    }
  });

  void it('BUG-181 exposes an event-driven prompt contract and truthful launch receipts', async () => {
    const { session } = await harness();
    try {
      const ctx = session.extensionRunner.createContext();
      const systemPrompt = ctx.getSystemPrompt();
      assert.match(systemPrompt, /Do not call sleep, bg_status, or bg_logs merely to wait/);
      assert.match(systemPrompt, /automatically starts a follow-up agent turn/);
      assert.match(systemPrompt, /A running result is not an instruction to poll again/);
      assert.match(systemPrompt, /Do not repeatedly call bg_logs to wait for completion/);
      assert.match(systemPrompt, /Treat <background-task-notification> as durable terminal truth/);
      assert.doesNotMatch(
        systemPrompt,
        /After bg_run, use bg_status and bg_logs to inspect progress/,
      );

      const bgRun = session.getToolDefinition('bg_run');
      const bgStatus = session.getToolDefinition('bg_status');
      const bgLogs = session.getToolDefinition('bg_logs');
      assert.ok(bgRun && bgStatus && bgLogs, 'background tools should be registered');
      assert.match(bgRun.description, /do not sleep or poll merely to wait/);
      assert.match(bgStatus.description, /not a waiting primitive/);
      assert.match(bgLogs.description, /not a waiting primitive/);

      // shellQuote emits POSIX single quotes, which cmd.exe does not understand.
      const longCommand = `node -e ${JSON.stringify('setTimeout(() => {}, 10000)')}`;
      const cases = [
        {
          name: 'Default Delivery',
          notifyOnCompletion: undefined,
          triggerOnCompletion: undefined,
          expectedNotify: true,
          expectedTrigger: true,
          expected: [
            'Terminal notification: enabled.',
            'Automatic follow-up turn: enabled.',
            'Next action: do not poll or sleep',
          ],
        },
        {
          name: 'Notification Only',
          notifyOnCompletion: true,
          triggerOnCompletion: false,
          expectedNotify: true,
          expectedTrigger: false,
          expected: [
            'Terminal notification: enabled.',
            'Automatic follow-up turn: disabled.',
            'will not start an agent turn',
          ],
        },
        {
          name: 'Disabled Requested Wake',
          notifyOnCompletion: false,
          triggerOnCompletion: true,
          expectedNotify: false,
          expectedTrigger: true,
          expected: [
            'Terminal notification: disabled.',
            'Automatic follow-up turn: disabled because terminal notifications are disabled.',
            'triggerOnCompletion has no effect',
          ],
        },
        {
          name: 'Manual Delivery',
          notifyOnCompletion: false,
          triggerOnCompletion: false,
          expectedNotify: false,
          expectedTrigger: false,
          expected: [
            'Terminal notification: disabled.',
            'Automatic follow-up turn: disabled.',
            'deliberate manual monitoring',
          ],
        },
      ] as const;

      for (const testCase of cases) {
        const params = {
          isAgent: false,
          name: testCase.name,
          command: longCommand,
          ...(testCase.notifyOnCompletion === undefined
            ? {}
            : { notifyOnCompletion: testCase.notifyOnCompletion }),
          ...(testCase.triggerOnCompletion === undefined
            ? {}
            : { triggerOnCompletion: testCase.triggerOnCompletion }),
        };
        const result = await exec(session, 'bg_run', params);
        const task = taskFromResult(result);
        assert.equal(task.notifyOnCompletion, testCase.expectedNotify);
        assert.equal(task.triggerOnCompletion, testCase.expectedTrigger);
        for (const expected of testCase.expected) {
          assert.ok(
            resultText(result).includes(expected),
            `${testCase.name} receipt should include ${JSON.stringify(expected)}`,
          );
        }
        assert.equal(
          Reflect.get(result, 'terminate'),
          undefined,
          'bg_run must remain non-terminating for workflows that continue useful work',
        );
      }
    } finally {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
    }
  });

  void it('serves real extension EventBus requests and terminal events through the shared registry', async () => {
    const eventBus = createEventBus();
    const terminals: BgTaskSnapshot[] = [];
    const eventOrder: string[] = [];
    const unsubscribeResponseOrder = eventBus.on(BG_RESPONSE_CHANNEL, (data) => {
      const response = requireEventResponse(data);
      if (response.request_id === 'sdk-run' || response.request_id === 'sdk-kill') {
        eventOrder.push(`response:${response.request_id}`);
      }
    });
    const unsubscribeTerminal = eventBus.on(BG_TERMINAL_CHANNEL, (data) => {
      const task = requireTerminal(data).task;
      terminals.push(task);
      eventOrder.push(`terminal:${task.id}:${task.status}`);
    });
    const { session, cwd } = await harness({ eventBus });
    try {
      await session.extensionRunner.emit({ type: 'session_start', reason: 'startup' });
      const caps = await emitEventRequest(eventBus, 'sdk-cap', 'capabilities', {});
      assert.deepEqual(requireOkResult(caps), BG_EXTENSION_CAPABILITIES);

      const run = await emitEventRequest(eventBus, 'sdk-run', 'run', {
        name: 'EventBus Echo',
        command: 'echo api-ok',
        isAgent: false,
        notifyOnCompletion: false,
        triggerOnCompletion: false,
      });
      const task = requiredTask(requireOkResult(run), 'run result task');
      assert.equal(task.name, 'EventBus Echo');
      assert.equal(task.ownerSession, session.sessionManager.getSessionId());
      assert.ok(
        task.status === 'running' || task.status === 'completed',
        `immediate run response status should be a valid launch snapshot, got ${task.status}`,
      );
      assert.ok(existsSync(resolve(cwd, task.outputPath)));
      const terminal = await waitForTerminalSnapshot(terminals, task.id);
      assert.equal(terminal.status, 'completed');
      assert.equal(terminals.filter((entry) => entry.id === task.id).length, 1);
      assert.ok(
        eventOrder.findIndex((entry) => entry === `terminal:${task.id}:completed`) >
          eventOrder.indexOf('response:sdk-run'),
        'completed terminal must follow the correlated run response',
      );

      const logs = await emitEventRequest(eventBus, 'sdk-logs', 'logs', {
        taskId: task.id,
        maxBytes: 100,
        tail: true,
      });
      const logsResult = requiredJsonObject(requireOkResult(logs), 'logs result must be an object');
      assert.match(String(logsResult['text']), /api-ok/u);
      assert.equal(requiredTask(logsResult['task'], 'logs task').id, task.id);
      assert.equal(logsResult['tail'], true);

      const status = await emitEventRequest(eventBus, 'sdk-status', 'status', { taskId: task.id });
      const statusResult = requiredJsonObject(
        requireOkResult(status),
        'status result must be an object',
      );
      const statusTasks = statusResult['tasks'];
      assert.ok(Array.isArray(statusTasks), 'status tasks should be an array');
      assert.equal(requiredTask(statusTasks[0], 'status task').status, 'completed');

      const sleep = await emitEventRequest(eventBus, 'sdk-sleep', 'run', {
        name: 'EventBus Sleep',
        // `exec` is a POSIX shell builtin and shellQuote emits POSIX quoting;
        // neither is valid under cmd.exe. Node's own quoting handles both.
        command: `node -e ${JSON.stringify('setTimeout(() => {}, 5000)')}`,
        isAgent: false,
        notifyOnCompletion: false,
        triggerOnCompletion: false,
      });
      const sleepTask = requiredTask(requireOkResult(sleep), 'sleep run task');
      const kill = await emitEventRequest(eventBus, 'sdk-kill', 'kill', { taskId: sleepTask.id });
      const killResult = requiredJsonObject(requireOkResult(kill), 'kill result must be an object');
      assert.equal(requiredTask(killResult['task'], 'kill task').status, 'killed');
      const sleepTerminal = await waitForTerminalSnapshot(terminals, sleepTask.id);
      assert.equal(sleepTerminal.status, 'killed');
      assert.equal(terminals.filter((entry) => entry.id === sleepTask.id).length, 1);
      assert.ok(
        eventOrder.findIndex((entry) => entry === `terminal:${sleepTask.id}:killed`) >
          eventOrder.indexOf('response:sdk-kill'),
        'killed terminal must follow the kill response',
      );

      const malformed = await emitEventRequest(eventBus, 'sdk-malformed', 'run', {
        name: 'Bad EventBus Run',
        command: 'echo nope',
        isAgent: false,
        timeoutSeconds: null,
        notifyOnCompletion: true,
        triggerOnCompletion: true,
      });
      assert.equal(malformed.ok, false);
      assert.match(malformed.ok ? '' : malformed.error, /positive integer/u);

      const unknown = await emitEventRequest(eventBus, 'sdk-unknown', 'mystery', {});
      assert.equal(unknown.ok, false);
      assert.equal(unknown.operation, 'mystery');

      const firstDuplicate = await emitEventRequest(eventBus, 'sdk-dup', 'capabilities', {});
      assert.equal(firstDuplicate.ok, true);
      const duplicate = await emitEventRequest(eventBus, 'sdk-dup', 'capabilities', {});
      assert.equal(duplicate.ok, false);
      assert.match(duplicate.ok ? '' : duplicate.error, /duplicate request_id/u);
    } finally {
      unsubscribeTerminal();
      unsubscribeResponseOrder();
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
    }
  });

  void it('runs the structured bg_run_pi_attested tool and writes a complete flat attestation', async (t) => {
    if (skipWin32PiPathFixture(t, 'attested')) return;
    const { session, cwd, modelRegistry, modelRuntime } = await harness();
    const oldPath = process.env['PATH'];
    try {
      await initCleanGit(cwd);
      modelRegistry.registerProvider('openai-codex', {
        name: 'OpenAI Codex Test OAuth',
        baseUrl: 'https://example.invalid',
        apiKey: 'PI_BG_TEST_KEY',
        api: 'openai-codex-responses',
        models: [
          {
            id: 'gpt-5.5',
            name: 'GPT 5.5',
            reasoning: false,
            input: ['text'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 100000,
            maxTokens: 4096,
          },
        ],
      });
      // Pi 0.83 builds its own ModelRegistry facade per session, so the OAuth
      // observation must be stubbed on the shared ModelRuntime it delegates to.
      const originalOAuth = modelRuntime.isUsingOAuth.bind(modelRuntime);
      modelRuntime.isUsingOAuth = (providerId: string) =>
        providerId === 'openai-codex' ? true : originalOAuth(providerId);
      const bin = join(cwd, 'bin');
      await mkdir(bin, { recursive: true });
      const fakePi = join(bin, 'pi');
      await writeFile(
        fakePi,
        `#!/usr/bin/env node
const { writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
if (args[0] !== '--mode' || args[1] !== 'json') process.exit(10);
writeFileSync('report.md', 'sdk report\\n');
const provider = args[args.indexOf('--provider') + 1];
const model = args[args.indexOf('--model') + 1];
const events = [
  { type: 'session', version: 3, id: 'pi-session-sdk', timestamp: '2026-01-01T00:00:00.000Z', cwd: process.cwd() },
  { type: 'agent_start' },
  { type: 'message_end', message: { role: 'assistant', provider, model, usage: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { total: 0.44 } }, content: [{ type: 'text', text: 'sdk attested done' }], stopReason: 'stop' } },
  { type: 'agent_end', messages: [] },
];
for (const event of events) console.log(JSON.stringify(event));
console.error('sdk stderr');
`,
        'utf8',
      );
      await chmod(fakePi, 0o755);
      process.env['PATH'] = `${bin}${delimiter}${oldPath ?? ''}`;

      const result = await exec(session, 'bg_run_pi_attested', {
        name: 'SDK Attested',
        provider: 'openai-codex',
        model: 'gpt-5.5',
        prompt: 'produce sdk attestation',
        reportPath: 'report.md',
        extraPiArgs: ['--no-extensions'],
      });
      const task = await wait(session, taskFromResult(result).id, 100);
      assert.equal(task.status, 'completed');
      assert.match(task.id, /^b[0-9a-f]{32}$/);
      assert.equal(task.model, 'openai-codex/gpt-5.5');
      assert.deepEqual(task.tokenUsage, {
        input: 20,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 30,
        costTotal: 0.44,
      });
      const attestationPath = join(cwd, task.outputPath.replace(/\.output$/, '.attestation.json'));
      for (let attempt = 0; attempt < 100 && !existsSync(attestationPath); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.ok(existsSync(attestationPath));
      const attestation = parseJsonObject(
        await readFile(attestationPath, 'utf8'),
        'SDK attestation should be JSON',
      );
      const invocation = requiredJsonObject(attestation['invocation'], 'invocation');
      assert.equal(invocation['pi_session_id'], 'pi-session-sdk');
      assert.deepEqual(invocation['argv'], [
        'pi',
        '--mode',
        'json',
        '--provider',
        'openai-codex',
        '--model',
        'gpt-5.5',
        '--no-extensions',
        'produce sdk attestation',
      ]);
      assert.equal(invocation['credential_kind'], 'oauth');
      const artifacts = requiredJsonObject(attestation['artifacts'], 'artifacts');
      const sourceHashes = requiredJsonObject(attestation['source_hashes'], 'source hashes');
      assert.equal(
        requiredJsonObject(artifacts['task_output'], 'task output')['sha256'],
        sourceHashes['output_sha256'],
      );
      assert.match(await readFile(join(cwd, task.outputPath), 'utf8'), /sdk attested done/);
      assert.match(
        await readFile(join(cwd, task.outputPath.replace(/\.output$/, '.stderr')), 'utf8'),
        /sdk stderr/,
      );
    } finally {
      restoreEnvValue('PATH', oldPath);
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
    }
  });

  void it('supports status/log prefix resolution, all-task listing, head/tail truncation, and ambiguous/unknown ID errors', async () => {
    const { session } = await harness();
    try {
      const first = await exec(session, 'bg_run', {
        isAgent: false,
        name: 'SDK First',
        // The head/tail assertions below are byte-exact, so the command must
        // emit exactly six bytes with no trailing newline. `printf` is
        // POSIX-only and `echo` appends a newline, so use node directly.
        command: `node -e ${JSON.stringify('process.stdout.write("abcdef")')}`,
        notifyOnCompletion: false,
        triggerOnCompletion: false,
      });
      const second = await exec(session, 'bg_run', {
        isAgent: false,
        name: 'SDK Second',
        command: `node -e ${JSON.stringify('process.stdout.write("123456")')}`,
        notifyOnCompletion: false,
        triggerOnCompletion: false,
      });
      const firstDone = await wait(session, taskFromResult(first).id);
      await wait(session, taskFromResult(second).id);
      const all = await exec(session, 'bg_status', {});
      assert.ok(tasksFromResult(all).length >= 2);
      const byPrefix = await exec(session, 'bg_status', { taskId: firstDone.id.slice(0, 5) });
      assert.equal(firstTask(byPrefix).id, firstDone.id);
      await assert.rejects(
        () => exec(session, 'bg_status', { taskId: 'b' }),
        /Ambiguous task ID prefix/,
      );
      await assert.rejects(
        () => exec(session, 'bg_status', { taskId: 'bdeadbeef' }),
        /Unknown background task ID/,
      );
      const head = await exec(session, 'bg_logs', {
        taskId: firstDone.id,
        maxBytes: 3,
        tail: false,
      });
      assert.match(resultText(head), /^abc/);
      assert.match(resultText(head), /Showing head/);
      const tail = await exec(session, 'bg_logs', {
        taskId: firstDone.id,
        maxBytes: 3,
        tail: true,
      });
      assert.match(resultText(tail), /def/);
      assert.match(resultText(tail), /Showing tail/);
      await assert.rejects(
        () => exec(session, 'bg_logs', { taskId: 'bdeadbeef' }),
        /Unknown background task ID/,
      );
    } finally {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
    }
  });

  void it('kills running tasks and rejects unknown or completed kills loudly', async () => {
    const { session } = await harness();
    try {
      const r = await exec(session, 'bg_run', {
        isAgent: false,
        name: 'SDK Sleep',
        command: `node -e ${JSON.stringify('setTimeout(() => {}, 10000)')}`,
        notifyOnCompletion: false,
        triggerOnCompletion: false,
      });
      const task = taskFromResult(r);
      const k = await exec(session, 'bg_kill', { taskId: task.id.slice(0, 6) });
      assert.match(resultText(k), /Killed/);
      const t = await wait(session, task.id);
      assert.equal(t.status, 'killed');
      await assert.rejects(() => exec(session, 'bg_kill', { taskId: t.id }), /not running/);
      await assert.rejects(
        () => exec(session, 'bg_kill', { taskId: 'bdeadbeef' }),
        /Unknown background task ID/,
      );
    } finally {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
    }
  });

  void it('fails timed-out tasks loudly', async () => {
    const { session } = await harness();
    try {
      const r = await exec(session, 'bg_run', {
        isAgent: false,
        name: 'SDK Timeout',
        command: `node -e ${JSON.stringify('setTimeout(() => {}, 5000)')}`,
        timeoutSeconds: 1,
        notifyOnCompletion: false,
        triggerOnCompletion: false,
      });
      const t = await wait(session, taskFromResult(r).id, 80);
      assert.equal(t.status, 'failed');
      assert.match(t.error ?? '', /Timed out after 1s/);
      const logs = await exec(session, 'bg_logs', { taskId: t.id, maxBytes: 1000 });
      assert.match(resultText(logs), /background task timeout/);
    } finally {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
    }
  });

  void it('records completion notifications exactly once when enabled and suppresses them when disabled', async () => {
    const { session } = await harness();
    try {
      const notified = await exec(session, 'bg_run', {
        isAgent: false,
        name: 'Notify SDK',
        // The payload deliberately contains <, > and & to exercise escaping of
        // task output. Those are cmd.exe redirection and separator
        // metacharacters, so the literal must not appear in the command line;
        // it is rebuilt from character codes inside the child instead.
        command: `node -e ${JSON.stringify(
          'process.stdout.write(String.fromCharCode(60)+"ok"+String.fromCharCode(62,38)+"done")',
        )}`,
        notifyOnCompletion: true,
        triggerOnCompletion: false,
      });
      const hidden = await exec(session, 'bg_run', {
        isAgent: false,
        name: 'No Notify SDK',
        command: 'echo quiet',
        notifyOnCompletion: false,
        triggerOnCompletion: false,
      });
      await wait(session, taskFromResult(notified).id);
      const hiddenTask = taskFromResult(hidden);
      await wait(session, hiddenTask.id);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const notes = customNotifications(session);
      assert.equal(notes.length, 1);
      const note = notes[0];
      assert.ok(note, 'completion notification should be recorded');
      assert.match(note.content, /<task-name>Notify SDK<\/task-name>/);
      assert.match(note.content, /<status>completed<\/status>/);
      assert.match(note.content, /&quot;|Notify SDK/);
      // The submitted payload precedes acknowledgement; the live registry
      // acknowledges only after this entry is actually in session history.
      assert.equal(note.details['notified'], false);
      const acknowledged = await exec(session, 'bg_status', { taskId: taskFromResult(notified).id });
      assert.equal(firstTask(acknowledged).notified, true);
      const status = await exec(session, 'bg_status', { taskId: hiddenTask.id });
      assert.equal(firstTask(status).notified, false);
    } finally {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
    }
  });

  void it('captures only task-owned explicit telemetry in snapshots and metadata', async () => {
    const { session, cwd } = await harness();
    try {
      const tool = session.getToolDefinition('bg_run');
      assert.ok(tool, 'bg_run tool should be registered');
      const ctx = session.extensionRunner.createContext();
      ctx.getContextUsage = () => ({ tokens: 999_000, contextWindow: 1_000_000, percent: 99.9 });
      const script = `console.log(JSON.stringify({ type: "background-task-telemetry", model: "test-provider/test-model", contextUsage: { tokens: 50000, contextWindow: 200000, percent: 25 }, tokenUsage: { input: 1000, output: 200, cacheRead: 30, cacheWrite: 20, totalTokens: 1250 }, toolUsage: { total: 2, failed: 1, byName: { read: 1, bash: 1 } } })); console.log("context");`;
      const command = `node -e ${JSON.stringify(script)}`;
      const rawResult: unknown = await tool.execute(
        'call-context',
        {
          isAgent: true,
          name: 'Context SDK',
          command,
          notifyOnCompletion: false,
          triggerOnCompletion: false,
        },
        undefined,
        undefined,
        ctx,
      );
      assert.ok(isTestToolResult(rawResult), 'bg_run should return a typed tool result');
      const t = await wait(session, taskFromResult(rawResult).id);
      assert.deepEqual(t.contextUsage, { tokens: 50_000, contextWindow: 200_000, percent: 25 });
      assert.deepEqual(t.tokenUsage, {
        input: 1000,
        output: 200,
        cacheRead: 30,
        cacheWrite: 20,
        totalTokens: 1250,
      });
      assert.deepEqual(t.toolUsage, { total: 2, failed: 1, byName: { read: 1, bash: 1 } });
      assert.equal(t.model, 'test-provider/test-model');
      const status = await exec(session, 'bg_status', { taskId: t.id });
      assert.match(resultText(status), /ctx=25\.0%\/200k/);
      assert.match(resultText(status), /model=test-provider\/test-model/);
      assert.match(resultText(status), /tokens=1\.3k/);
      assert.match(resultText(status), /tools=2 failed=1/);
      const metadataPath = join(cwd, t.outputPath.replace(/\.output$/, '.json'));
      let metadata = parseJsonObject(
        await readFile(metadataPath, 'utf8'),
        'telemetry metadata should be an object',
      );
      for (let attempt = 0; attempt < 40; attempt++) {
        metadata = parseJsonObject(
          await readFile(metadataPath, 'utf8'),
          'telemetry metadata should be an object',
        );
        if (metadata['contextUsage'] !== undefined) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.deepEqual(metadata['contextUsage'], {
        tokens: 50_000,
        contextWindow: 200_000,
        percent: 25,
      });
      assert.deepEqual(metadata['tokenUsage'], t.tokenUsage);
      assert.deepEqual(metadata['toolUsage'], t.toolUsage);
      assert.equal(metadata['model'], 'test-provider/test-model');

      const legacy = await exec(session, 'bg_run', {
        isAgent: true,
        name: 'Legacy Context SDK',
        command: `node -e ${JSON.stringify('console.log(JSON.stringify({ type: "background-task-context-usage", tokens: 42, contextWindow: 1000, percent: 4.2 }))')}`,
        notifyOnCompletion: false,
        triggerOnCompletion: false,
      });
      const legacyTask = await wait(session, taskFromResult(legacy).id);
      assert.deepEqual(legacyTask.contextUsage, { tokens: 42, contextWindow: 1000, percent: 4.2 });
      assert.equal(legacyTask.tokenUsage, undefined);

      const noTelemetry = await exec(session, 'bg_run', {
        isAgent: false,
        name: 'No Context SDK',
        command: 'echo no-context',
        notifyOnCompletion: false,
        triggerOnCompletion: false,
      });
      const noTelemetryTask = await wait(session, taskFromResult(noTelemetry).id);
      assert.equal(noTelemetryTask.contextUsage, undefined);
      assert.equal(noTelemetryTask.tokenUsage, undefined);
      assert.equal(noTelemetryTask.toolUsage, undefined);
      assert.equal(noTelemetryTask.model, undefined);
    } finally {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
    }
  });

  void it('wraps explicitly marked background Pi agents and captures context telemetry', async (t) => {
    if (skipWin32PosixPiTelemetry(t)) return;
    const { session, cwd } = await harness();
    const oldPath = process.env['PATH'];
    try {
      const bin = join(cwd, 'bin');
      await mkdir(bin, { recursive: true });
      const fakePi = join(bin, 'pi');
      await writeFile(
        fakePi,
        `#!/usr/bin/env node
const args = process.argv.slice(2);
if (!args.includes("--mode") || args[args.indexOf("--mode") + 1] !== "json") {
  console.error("expected --mode json: " + JSON.stringify(args));
  process.exit(3);
}
if (args.includes("-p") || args.includes("--print")) {
  console.error("print flag should be removed: " + JSON.stringify(args));
  process.exit(4);
}
const firstMessage = {
  role: "assistant",
  model: "openai-codex/gpt-5.5",
  usage: { input: 1000, output: 200, cacheRead: 30, cacheWrite: 20, totalTokens: 1250 },
  content: [{ type: "toolCall", id: "call-read", name: "read", arguments: { path: "README.md" } }],
  stopReason: "toolUse",
  timestamp: Date.now()
};
const secondMessage = {
  role: "assistant",
  model: "openai-codex/gpt-5.5",
  usage: { input: 300, output: 50, cacheRead: 0, cacheWrite: 10, totalTokens: 360 },
  content: [{ type: "text", text: "fake child final" }],
  stopReason: "stop",
  timestamp: Date.now()
};
console.log(JSON.stringify({ type: "message_end", message: firstMessage }));
console.log(JSON.stringify({ type: "tool_execution_start", toolCallId: "call-read", toolName: "read", args: { path: "README.md" } }));
console.log(JSON.stringify({ type: "tool_execution_end", toolCallId: "call-read", toolName: "read", result: {}, isError: false }));
console.log(JSON.stringify({ type: "tool_execution_start", toolCallId: "call-bash", toolName: "bash", args: { command: "false" } }));
console.log(JSON.stringify({ type: "tool_execution_end", toolCallId: "call-bash", toolName: "bash", result: {}, isError: true }));
console.log(JSON.stringify({ type: "message_end", message: secondMessage }));
`,
        'utf8',
      );
      await chmod(fakePi, 0o755);
      process.env['PATH'] = `${bin}${delimiter}${oldPath ?? ''}`;

      const r = await exec(session, 'bg_run', {
        isAgent: true,
        name: 'Wrapped Pi Agent',
        command: 'pi --model openai-codex/gpt-5.5 -p hello',
        notifyOnCompletion: false,
        triggerOnCompletion: false,
      });
      const t = await wait(session, taskFromResult(r).id);
      assert.equal(t.status, 'completed', await readFile(join(cwd, t.outputPath), 'utf8'));
      assert.deepEqual(t.contextUsage, {
        tokens: 360,
        contextWindow: 272000,
        percent: (360 / 272000) * 100,
      });
      assert.deepEqual(t.tokenUsage, {
        input: 1300,
        output: 250,
        cacheRead: 30,
        cacheWrite: 30,
        totalTokens: 1610,
      });
      assert.deepEqual(t.toolUsage, { total: 2, failed: 1, byName: { read: 1, bash: 1 } });
      assert.equal(t.model, 'openai-codex/gpt-5.5');
      const status = await exec(session, 'bg_status', { taskId: t.id });
      assert.match(resultText(status), /model=openai-codex\/gpt-5\.5/);
      assert.match(resultText(status), /tokens=1\.6k/);
      assert.match(resultText(status), /tools=2 failed=1/);
      const logs = await exec(session, 'bg_logs', { taskId: t.id, maxBytes: 4000, tail: false });
      const logText = resultText(logs);
      assert.match(logText, /\u2192 read README\.md/);
      assert.match(logText, /\u2717 bash failed/);
      assert.match(logText, /fake child final/);
      assert.doesNotMatch(logText, /background-task-telemetry/);
      assert.doesNotMatch(logText, /background-task-context-usage/);
      assert.doesNotMatch(logText, /background-task-activity/);
      const metadataPath = join(cwd, t.outputPath.replace(/\.output$/, '.json'));
      const metadata = parseJsonObject(
        await readFile(metadataPath, 'utf8'),
        'wrapped Pi metadata should be an object',
      );
      assert.deepEqual(metadata['contextUsage'], t.contextUsage);
      assert.deepEqual(metadata['tokenUsage'], t.tokenUsage);
      assert.deepEqual(metadata['toolUsage'], t.toolUsage);
      assert.equal(metadata['model'], 'openai-codex/gpt-5.5');
    } finally {
      restoreEnvValue('PATH', oldPath);
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
    }
  });

  void it(
    'wraps an explicitly marked real child Pi and counts JSON token/tool telemetry',
    { timeout: 20_000 },
    async (t) => {
      if (process.platform === 'win32') {
        t.skip('POSIX shell env-prefix child-pi telemetry smoke is not portable to Windows');
        return;
      }
      const piCli = resolvePiCli();
      if (!piCli) {
        t.skip('pi CLI is not available on PATH for real child-pi telemetry smoke');
        return;
      }
      const { session, cwd } = await harness();
      try {
        const childAgentDir = join(cwd, 'child-agent');
        const childSessionDir = join(cwd, 'child-sessions');
        await mkdir(childAgentDir, { recursive: true });
        await mkdir(childSessionDir, { recursive: true });
        const envPrefix = Object.entries({
          PI_BG_SCRIPTED_SCENARIO: 'json-tool-telemetry',
          PI_BG_SCRIPTED_API_KEY: 'scripted-api-key',
          PI_CODING_AGENT_DIR: childAgentDir,
          PI_CODING_AGENT_SESSION_DIR: childSessionDir,
          PI_OFFLINE: '1',
          PI_SKIP_VERSION_CHECK: '1',
          PI_TELEMETRY: '0',
          CI: '1',
          PATH: `${dirname(piCli)}${delimiter}${process.env['PATH'] ?? ''}`,
        })
          .map(([key, value]) => `${key}=${shellQuote(value)}`)
          .join(' ');
        const command = `${envPrefix} pi --offline --no-session --no-extensions -e ${shellQuote(scriptedProviderPath)} --no-skills --no-prompt-templates --no-context-files --model pi-bg-scripted/scripted-model -p ${shellQuote('exercise real json tool telemetry')}`;
        const r = await exec(session, 'bg_run', {
          isAgent: true,
          name: 'Real Pi Telemetry',
          command,
          notifyOnCompletion: false,
          triggerOnCompletion: false,
        });
        const t = await wait(session, taskFromResult(r).id, 240);
        assert.equal(t.status, 'completed', await readFile(join(cwd, t.outputPath), 'utf8'));
        assert.deepEqual(t.tokenUsage, {
          input: 20,
          output: 10,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 30,
          costTotal: 0,
        });
        assert.deepEqual(t.toolUsage, { total: 2, failed: 1, byName: { scripted_echo: 2 } });
        assert.equal(t.model, 'pi-bg-scripted/scripted-model');
        const status = await exec(session, 'bg_status', { taskId: t.id });
        assert.match(resultText(status), /model=pi-bg-scripted\/scripted-model/);
        assert.match(resultText(status), /tokens=30/);
        assert.match(resultText(status), /tools=2 failed=1/);
        const logs = await exec(session, 'bg_logs', { taskId: t.id, maxBytes: 8000, tail: false });
        const logText = resultText(logs);
        assert.match(logText, /JSON tool telemetry complete/);
        assert.match(logText, /scripted_echo/);
        assert.doesNotMatch(logText, /background-task-telemetry/);
      } finally {
        await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
        session.dispose();
      }
    },
  );

  void it('keeps finished footer notices until explicit /bg-clear', async () => {
    const { session } = await harness();
    const statuses: Array<string | undefined> = [];
    const notifications: UiNotification[] = [];
    session.extensionRunner.setUIContext(
      makeStatusUi(session.extensionRunner.getUIContext(), statuses, notifications),
    );
    try {
      const done = await exec(session, 'bg_run', {
        isAgent: false,
        name: 'Footer Done',
        command: 'echo done',
        notifyOnCompletion: false,
        triggerOnCompletion: false,
      });
      await wait(session, taskFromResult(done).id);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.match(statuses.at(-1) ?? '', /bg 1 done · Shift↓ · \/bg-clear/);

      const shortcuts = session.extensionRunner.getShortcuts({});
      assert.ok(shortcuts.has('ctrl+alt+c'));
      const clearCommand = session.extensionRunner
        .getRegisteredCommands()
        .find((cmd) => cmd.invocationName === 'bg-clear');
      assert.ok(clearCommand);
      await clearCommand.handler('', session.extensionRunner.createCommandContext());
      assert.match(statuses.at(-1) ?? '', /bg idle · Shift↓/);
      assert.match(notifications.at(-1)?.message ?? '', /Cleared 1 finished/);

      const running = await exec(session, 'bg_run', {
        isAgent: false,
        name: 'Footer Running',
        command: `node -e ${JSON.stringify('setTimeout(() => {}, 10000)')}`,
        notifyOnCompletion: false,
        triggerOnCompletion: false,
      });
      const secondDone = await exec(session, 'bg_run', {
        isAgent: false,
        name: 'Footer Done Two',
        command: 'echo two',
        notifyOnCompletion: false,
        triggerOnCompletion: false,
      });
      await wait(session, taskFromResult(secondDone).id);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.match(statuses.at(-1) ?? '', /1 running · 1 done · Shift↓ · \/bg-clear/);
      await clearCommand.handler('', session.extensionRunner.createCommandContext());
      assert.match(statuses.at(-1) ?? '', /bg 1 running · Shift↓/);
      assert.doesNotMatch(statuses.at(-1) ?? '', /done|\/bg-clear/);
      await exec(session, 'bg_kill', { taskId: taskFromResult(running).id });
    } finally {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
    }
  });

  void it('reports failed/stopped/done footer combinations and focused dock status', async () => {
    const { session } = await harness();
    const statuses: Array<string | undefined> = [];
    const notifications: UiNotification[] = [];
    session.extensionRunner.setUIContext(
      makeStatusUi(session.extensionRunner.getUIContext(), statuses, notifications),
    );
    try {
      const failed = await exec(session, 'bg_run', {
        isAgent: false,
        name: 'Footer Failed',
        command: 'node -e "process.exit(2)"',
        notifyOnCompletion: false,
        triggerOnCompletion: false,
      });
      await wait(session, taskFromResult(failed).id);
      const stopped = await exec(session, 'bg_run', {
        isAgent: false,
        name: 'Footer Stopped',
        command: `node -e ${JSON.stringify('setTimeout(() => {}, 10000)')}`,
        notifyOnCompletion: false,
        triggerOnCompletion: false,
      });
      const stoppedTask = taskFromResult(stopped);
      await exec(session, 'bg_kill', { taskId: stoppedTask.id });
      await wait(session, stoppedTask.id);
      const done = await exec(session, 'bg_run', {
        isAgent: false,
        name: 'Footer Done Matrix',
        command: 'echo done',
        notifyOnCompletion: false,
        triggerOnCompletion: false,
      });
      await wait(session, taskFromResult(done).id);
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.match(statuses.at(-1) ?? '', /1 failed · 1 stopped · 1 done · Shift↓ · \/bg-clear/);

      const running = await exec(session, 'bg_run', {
        isAgent: false,
        name: 'Footer Focused',
        command: `node -e ${JSON.stringify('setTimeout(() => {}, 10000)')}`,
        notifyOnCompletion: false,
        triggerOnCompletion: false,
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.match(
        statuses.at(-1) ?? '',
        /1 running · 1 failed · 1 stopped · 1 done · Shift↓ · \/bg-clear/,
      );
      const shortcuts = session.extensionRunner.getShortcuts({});
      const shiftDown = shortcuts.get('shift+down');
      assert.ok(shiftDown, 'Shift+Down shortcut should be registered');
      await shiftDown.handler(session.extensionRunner.createContext());
      assert.ok(
        statuses.some(
          (status) =>
            status?.includes('bg 1 running · 1 failed · 1 stopped · 1 done · focused') ?? false,
        ),
      );
      await exec(session, 'bg_kill', { taskId: taskFromResult(running).id });
      assert.equal(notifications.length, 0);
    } finally {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
    }
  });

  void it('uses bg_run prepareArguments for legacy calls without names', async () => {
    const { session } = await harness();
    try {
      const tool = session.getToolDefinition('bg_run');
      assert.ok(tool?.prepareArguments);
      const prepared = requiredPrepared(
        tool.prepareArguments({ command: 'npm run qa', description: 'Legacy QA', isAgent: false }),
      );
      assert.equal(prepared.name, 'Legacy QA');
      assert.equal(prepared.isAgent, false);
      const agent = requiredPrepared(
        tool.prepareArguments({ name: 'Legacy Agent', command: 'pi -p hi', isAgent: true }),
      );
      assert.equal(agent.isAgent, true);
      assert.throws(
        () => tool.prepareArguments?.({ command: 'pnpm test' }),
        /requires isAgent boolean/,
      );
      assert.throws(() => tool.prepareArguments?.(null), /arguments must be an object/);
      const invalid = { name: 'Background task', command: '', isAgent: false };
      await assert.rejects(
        () => exec(session, 'bg_run', { name: 'Missing Agent Flag', command: 'echo ok' }),
        /requires isAgent boolean/,
      );
      await assert.rejects(() => exec(session, 'bg_run', invalid), /Background command is empty/);
    } finally {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
    }
  });

  void it('fails spawn errors loudly and writes failure metadata', async () => {
    const previousShell = process.env['SHELL'];
    const previousComSpec = process.env['ComSpec'];
    if (process.platform === 'win32') {
      process.env['ComSpec'] = 'C:\\definitely\\missing\\pi-bg-shell.exe';
    } else {
      process.env['SHELL'] = '/definitely/missing/pi-bg-shell';
    }
    const { session, cwd } = await harness();
    try {
      const r = await exec(session, 'bg_run', {
        isAgent: false,
        name: 'Bad Shell',
        command: 'echo nope',
        notifyOnCompletion: false,
        triggerOnCompletion: false,
      });
      const t = await wait(session, taskFromResult(r).id);
      assert.equal(t.status, 'failed');
      assert.match(t.error ?? '', /ENOENT|no such file/i);
      const metadataPath = join(dirname(resolve(cwd, t.outputPath)), 'record.json');
      const metadata = await readJsonWithStatus(metadataPath, 'failed');
      assert.equal(metadata['status'], 'failed');
    } finally {
      restoreEnvValue('SHELL', previousShell);
      restoreEnvValue('ComSpec', previousComSpec);
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
    }
  });

  void it('hands running tasks and terminal history across extension reload', async () => {
    const { session } = await harness();
    const statuses: Array<string | undefined> = [];
    const notifications: UiNotification[] = [];
    await session.bindExtensions({
      uiContext: makeStatusUi(session.extensionRunner.getUIContext(), statuses, notifications),
    });
    try {
      const completedLaunch = await exec(session, 'bg_run', {
        isAgent: false,
        name: 'SDK Reload Complete',
        command: `node -e ${JSON.stringify("process.stdout.write('reload-history')")}`,
        notifyOnCompletion: false,
        triggerOnCompletion: false,
      });
      const completed = await wait(session, taskFromResult(completedLaunch).id);
      assert.equal(completed.status, 'completed');

      const runningLaunch = await exec(session, 'bg_run', {
        isAgent: false,
        name: 'SDK Reload Running',
        command: `node -e ${JSON.stringify("setTimeout(() => process.stdout.write('reload-live'), 10000)")}`,
        notifyOnCompletion: false,
        triggerOnCompletion: false,
      });
      const runningId = taskFromResult(runningLaunch).id;

      await session.reload();

      const completedAfterReload = await exec(session, 'bg_status', { taskId: completed.id });
      assert.equal(firstTask(completedAfterReload).status, 'completed');
      const logsAfterReload = await exec(session, 'bg_logs', {
        taskId: completed.id,
        maxBytes: 1000,
      });
      assert.match(resultText(logsAfterReload), /reload-history/);

      const runningAfterReload = await exec(session, 'bg_status', { taskId: runningId });
      assert.equal(firstTask(runningAfterReload).status, 'running');
      await exec(session, 'bg_kill', { taskId: runningId });
    } finally {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
    }
  });

  void it('suppresses old completion on the same extension session transition', async () => {
    const { session } = await harness();
    await session.bindExtensions({});
    try {
      const task = taskFromResult(await exec(session, 'bg_run', {
        isAgent: false, name: 'Same extension transition',
        command: `node -e ${JSON.stringify("setTimeout(() => {}, 1500)")}`,
        notifyOnCompletion: true, triggerOnCompletion: true,
      }));
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      const manager = session.sessionManager;
      const originalId = manager.getSessionId();
      for (const reason of ['new', 'fork'] as const) {
        manager.newSession();
        assert.notEqual(manager.getSessionId(), originalId);
        await session.extensionRunner.emit({ type: 'session_start', reason });
        await assert.rejects(() => exec(session, 'bg_status', { taskId: task.id }), /Unknown/);
        await assert.rejects(() => exec(session, 'bg_kill', { taskId: task.id }), /Unknown/);
      }
      assert.equal(customNotifications(session).length, 0);
    } finally {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
    }
  });

  void it('preserves durable commands across SDK session shutdown and fresh session restoration', async () => {
    const first = await harness();
    await first.session.bindExtensions({});
    const running = taskFromResult(await exec(first.session, 'bg_run', {
      isAgent: false, name: 'SDK Surviving Command',
      command: `node -e ${JSON.stringify('setTimeout(() => {}, 30000)')}`,
      notifyOnCompletion: true, triggerOnCompletion: false,
    }));
    const offline = taskFromResult(await exec(first.session, 'bg_run', {
      isAgent: false, name: 'SDK Offline Completion',
      command: `node -e ${JSON.stringify("setTimeout(() => process.stdout.write('offline-done'), 1000)")}`,
      notifyOnCompletion: true, triggerOnCompletion: false,
    }));
    const foreign = await harness({ cwd: first.cwd });
    await foreign.session.bindExtensions({});
    try {
      const foreignTask = taskFromResult(await exec(foreign.session, 'bg_run', {
        isAgent: false, name: 'Other session task', command: `node -e ${JSON.stringify('setTimeout(() => {}, 30000)')}`, notifyOnCompletion: false,
      }));
      await assert.rejects(() => exec(first.session, 'bg_status', { taskId: foreignTask.id }), /Unknown/);
      await assert.rejects(() => exec(first.session, 'bg_kill', { taskId: foreignTask.id }), /Unknown/);
      await exec(foreign.session, 'bg_kill', { taskId: foreignTask.id });
      await assert.rejects(() => exec(foreign.session, 'bg_status', { taskId: running.id }), /Unknown/);
      await assert.rejects(() => exec(foreign.session, 'bg_kill', { taskId: running.id }), /Unknown/);
      await assert.rejects(() => exec(foreign.session, 'bg_logs', { taskId: running.id }), /Unknown/);
    } finally {
      await foreign.session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      foreign.session.dispose();
    }
    await first.session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    first.session.dispose();
    await new Promise(resolve => setTimeout(resolve, 1500));
    const eventBus = createEventBus();
    const terminals: unknown[] = [];
    const unsubscribe = eventBus.on(BG_TERMINAL_CHANNEL, event => { terminals.push(event); });
    const second = await harness({ cwd: first.cwd, eventBus, sessionManager: first.session.sessionManager });
    try {
      await second.session.bindExtensions({ uiContext: second.session.extensionRunner.getUIContext() });
      const restored = firstTask(await exec(second.session, 'bg_status', { taskId: running.id }));
      assert.equal(restored.status, 'running');
      assert.equal(restored.outputPath, running.outputPath);
      const completed = await wait(second.session, offline.id);
      assert.equal(completed.status, 'completed');
      assert.equal(completed.notifyOnCompletion, true);
      assert.equal(completed.triggerOnCompletion, false);
      await waitForNotification(second.session, offline.id);
      assert.match(resultText(await exec(second.session, 'bg_logs', { taskId: offline.id })), /offline-done/);
      await exec(second.session, 'bg_kill', { taskId: running.id });
      assert.equal((await wait(second.session, running.id)).status, 'killed');
      await waitForNotification(second.session, running.id);
      assert.equal(customNotifications(second.session).filter(entry => entry.details['id'] === offline.id).length, 1);
      await second.session.reload();
      assert.equal(customNotifications(second.session).filter(entry => entry.details['id'] === offline.id).length, 1);
      assert.deepEqual(terminals, []);
    } finally {
      unsubscribe();
      await second.session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      second.session.dispose();
    }
  });

  void it('delivers a notification-enabled durable task once across pure reload and fresh recovery off its receipt branch', async () => {
    const first = await harness();
    await first.session.bindExtensions({ uiContext: first.session.extensionRunner.getUIContext() });
    const manager = first.session.sessionManager;
    const branchPoint = manager.appendMessage({ role: 'user', content: 'receipt branch anchor', timestamp: Date.now() });
    const task = taskFromResult(await exec(first.session, 'bg_run', {
      isAgent: false, name: 'Reload notification',
      command: `node -e ${JSON.stringify('setTimeout(() => {}, 1000)')}`,
      notifyOnCompletion: true, triggerOnCompletion: false,
    }));
    try {
      await first.session.reload();
      await waitForNotification(first.session, task.id);
      assert.equal(customNotifications(first.session).filter(entry => entry.details['id'] === task.id).length, 1);
      await first.session.reload();
      assert.equal(customNotifications(first.session).filter(entry => entry.details['id'] === task.id).length, 1);
    } finally {
      await first.session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      first.session.dispose();
    }
    manager.branch(branchPoint);
    assert.equal(manager.getBranch().filter(isCustomNotificationEntry).length, 0);
    const recovered = await harness({ cwd: first.cwd, sessionManager: manager });
    try {
      await recovered.session.bindExtensions({ uiContext: recovered.session.extensionRunner.getUIContext() });
      const restored = firstTask(await exec(recovered.session, 'bg_status', { taskId: task.id }));
      assert.equal(restored.status, 'completed');
      assert.equal(restored.notifyOnCompletion, true);
      assert.equal(restored.triggerOnCompletion, false);
      // Allow restore and repeated registry delivery polls to observe the historical receipt.
      await new Promise(resolve => setTimeout(resolve, 1500));
      assert.equal(customNotifications(recovered.session).filter(entry => entry.details['id'] === task.id).length, 1);
      assert.equal(manager.getBranch().filter(isCustomNotificationEntry).length, 0);
    } finally {
      await recovered.session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      recovered.session.dispose();
    }
  });

  void it('cleans up multiple running agent tasks on shutdown', async () => {
    const { session } = await harness();
    const one = await exec(session, 'bg_run', {
      isAgent: true,
      name: 'SDK Shutdown One',
      command: `node -e ${JSON.stringify('setTimeout(() => {}, 10000)')}`,
      notifyOnCompletion: false,
      triggerOnCompletion: false,
    });
    const two = await exec(session, 'bg_run', {
      isAgent: true,
      name: 'SDK Shutdown Two',
      command: `node -e ${JSON.stringify('setTimeout(() => {}, 10000)')}`,
      notifyOnCompletion: false,
      triggerOnCompletion: false,
    });
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    const s1 = await exec(session, 'bg_status', { taskId: taskFromResult(one).id });
    const s2 = await exec(session, 'bg_status', { taskId: taskFromResult(two).id });
    assert.equal(firstTask(s1).status, 'killed');
    assert.equal(firstTask(s2).status, 'killed');
    assert.match(firstTask(s1).error ?? '', /shutdown/);
    session.dispose();
  });

  void it('surfaces an update-available footer segment and registers a non-installing /bg-update command', async () => {
    const saved = new Map<string, string | undefined>();
    for (const key of UPDATE_ENV_KEYS) {
      saved.set(key, process.env[key]);
      restoreEnvValue(key, undefined);
    }
    const registry = await startRegistry(
      JSON.stringify({ name: 'pi-background-tasks', version: '999.0.0' }),
    );
    process.env['PI_BG_REGISTRY_URL'] = registry.url;
    const { session } = await harness();
    const statuses: Array<string | undefined> = [];
    const notifications: UiNotification[] = [];
    session.extensionRunner.setUIContext(
      makeStatusUi(session.extensionRunner.getUIContext(), statuses, notifications),
    );
    try {
      const commands = session.extensionRunner
        .getRegisteredCommands()
        .map((cmd) => cmd.invocationName);
      assert.ok(commands.includes('bg-update'), 'bg-update command must be registered');

      await session.extensionRunner.emit({ type: 'session_start', reason: 'startup' });
      let footer: string | undefined;
      for (let i = 0; i < 50; i++) {
        await renderFooterViaJobs(session);
        footer = statuses.at(-1);
        if (footer?.includes('⬆ v999.0.0 /bg-update')) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.match(footer ?? '', /bg idle · Shift↓ · \u2b06 v999\.0\.0 \/bg-update/);

      // Append-to-active-footer path: segment trails the running/entry-hint status.
      const running = await exec(session, 'bg_run', {
        isAgent: false,
        name: 'Update Footer Running',
        command: `node -e ${JSON.stringify('setTimeout(() => {}, 10000)')}`,
        notifyOnCompletion: false,
        triggerOnCompletion: false,
      });
      await renderFooterViaJobs(session);
      assert.match(statuses.at(-1) ?? '', /bg 1 running · Shift↓ · \u2b06 v999\.0\.0 \/bg-update/);
      await exec(session, 'bg_kill', { taskId: taskFromResult(running).id });

      const updateCommand = session.extensionRunner
        .getRegisteredCommands()
        .find((cmd) => cmd.invocationName === 'bg-update');
      assert.ok(updateCommand);
      await updateCommand.handler('', session.extensionRunner.createCommandContext());
      const message = notifications.at(-1)?.message ?? '';
      assert.match(message, /pi install npm:pi-background-tasks@latest/);
      assert.match(message, /pi install npm:pi-background-tasks@999\.0\.0/);
      assert.match(
        message,
        /pi install git:github\.com\/ismailsaleekh\/pi-background-tasks@main/,
      );
      assert.match(message, /first verify the tag exists/);
      assert.doesNotMatch(message, /pi-background-tasks@v999\.0\.0/);
      assert.match(message, /999\.0\.0 is the latest published version/);
      assert.match(message, /does not install or self-update/);
    } finally {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
      await registry.close();
      for (const [key, value] of saved) {
        restoreEnvValue(key, value);
      }
    }
  });

  void it('shows no update segment when opted out, offline, already current, or the registry fails, and never throws', async () => {
    const newer = JSON.stringify({ version: '999.0.0' });
    const disabled = await settledFooter({
      env: { PI_BG_DISABLE_UPDATE_CHECK: '1' },
      registryPayload: newer,
    });
    assert.equal(disabled.threw, false);
    assert.doesNotMatch(disabled.status ?? '', /bg-update/);

    const offline = await settledFooter({ env: { PI_OFFLINE: '1' }, registryPayload: newer });
    assert.equal(offline.threw, false);
    assert.doesNotMatch(offline.status ?? '', /bg-update/);

    const packageInfoPayload = parseJsonText(
      await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
    );
    const currentVersion = parsePackageInfo(packageInfoPayload).version ?? '0.0.0';
    const current = await settledFooter({
      env: {},
      registryPayload: JSON.stringify({ version: currentVersion }),
    });
    assert.equal(current.threw, false);
    assert.doesNotMatch(current.status ?? '', /bg-update/);

    const failure = await settledFooter({ env: {}, registryPayload: '{}', registryStatus: 500 });
    assert.equal(failure.threw, false);
    assert.doesNotMatch(failure.status ?? '', /bg-update/);
  });
});
