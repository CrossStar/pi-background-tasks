import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseJsonText } from '../src/core/common.js';
import { isolatedTestEnv } from '../tests/helpers/normalize.js';

const requiredVersions = ['0.81.1', '0.82.1', '0.83.0', '0.84.0'] as const;
type RequiredPiVersion = (typeof requiredVersions)[number];
// `URL.pathname` yields `/D:/...` on Windows, which then joins into `D:\D:\...`.
const root = fileURLToPath(new URL('../', import.meta.url));

/**
 * TypeBox APIs removed in the 1.3.x line bundled by Pi 0.83.0 and 0.84.0. The
 * package must not reference these in source or in the packed tarball bytes.
 */
const REMOVED_TYPEBOX_APIS = [
  'Type.Base',
  'Type.Awaited',
  'Type.Promise',
  'Type.AsyncIterator',
  'Type.Iterator',
  'Type.Options',
  'Value.Mutate',
] as const;

/** Pi bundles typebox, so it must be a peer dependency with the documented "*" range. */
function verifyTypeBoxPeerPosture(): void {
  const manifest = parseJsonText(readFileSync(join(root, 'package.json'), 'utf8'));
  if (!isRecord(manifest)) throw new Error('package.json must be an object');
  const peers = manifest['peerDependencies'];
  if (!isRecord(peers)) throw new Error('package.json peerDependencies must be an object');
  if (peers['typebox'] !== '*') {
    throw new Error(
      `typebox must be declared as a "*" peer dependency per Pi package rules, saw ${String(peers['typebox'])}`,
    );
  }
  for (const key of ['@earendil-works/pi-coding-agent', '@earendil-works/pi-tui']) {
    const range = peers[key];
    if (typeof range !== 'string') {
      throw new Error(`${key} peer range must be a string, saw ${String(range)}`);
    }
    for (const version of requiredVersions) {
      if (!range.includes(version)) {
        throw new Error(`${key} peer range must declare Pi ${version} support, saw ${range}`);
      }
    }
  }
  const deps = manifest['dependencies'];
  if (isRecord(deps) && deps['typebox'] !== undefined)
    throw new Error('typebox must not be a runtime dependency; Pi bundles it');
  const bundled = manifest['bundledDependencies'];
  if (Array.isArray(bundled) && bundled.includes('typebox'))
    throw new Error('typebox must never be bundled');
}

interface PackFileEntry {
  filename: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  return value;
}

function run(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const npmExecPath = command === 'npm' ? env['npm_execpath'] : undefined;
  const result = spawnSync(npmExecPath ? process.execPath : command, npmExecPath ? [npmExecPath, ...args] : [...args], {
    cwd,
    encoding: 'utf8',
    env: { ...env, NPM_CONFIG_CACHE: env['NPM_CONFIG_CACHE'] ?? '/tmp/pi-npm-cache' },
  });
  if (result.error !== undefined) {
    throw new Error(`${command} could not start in ${cwd}: ${result.error.message}`, { cause: result.error });
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed in ${cwd}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout;
}

async function runRpcPromptUntil(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  prompt: string,
  expected: RegExp,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error: Error | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      if (error === undefined) resolve(stdout);
      else reject(error);
    };
    const timer = setTimeout(() => {
      finish(new Error(`RPC prompt timed out\n${stdout}\n${stderr}`));
    }, 20_000);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (expected.test(stdout)) finish(undefined);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      finish(error);
    });
    child.on('close', (code) => {
      if (!settled && code !== 0)
        finish(
          new Error(
            `RPC prompt exited ${code === null ? 'null' : String(code)}\n${stdout}\n${stderr}`,
          ),
        );
    });
    child.stdin.write(
      `${JSON.stringify({ type: 'prompt', message: prompt, id: 'compat-rpc-prompt' })}\n`,
    );
  });
}

function parsePack(text: string): PackFileEntry {
  const trimmed = text.trim();
  const arrayStart = trimmed.startsWith('[') ? 0 : text.lastIndexOf('\n[') + 1;
  if (arrayStart <= 0 && !trimmed.startsWith('[')) {
    throw new Error(
      `npm pack output must end with a JSON array; received ${JSON.stringify(text.slice(0, 160))}`,
    );
  }
  const parsed = parseJsonText(arrayStart === 0 ? trimmed : text.slice(arrayStart).trim());
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error('npm pack JSON output must contain exactly one package entry');
  }
  const first = parsed[0];
  if (!isRecord(first)) throw new Error('npm pack JSON entry must be an object');
  return { filename: requireString(first['filename'], 'pack filename') };
}

/**
 * Recursively scan installed package source for TypeBox APIs removed in 1.3.x.
 * This runs against the *installed* (packed) bytes, not the working tree, so a
 * removed API cannot reach users through the tarball.
 */
async function assertNoRemovedTypeBoxApis(packageDir: string, label: string): Promise<void> {
  const stack = [packageDir];
  let scanned = 0;
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') stack.push(path);
        continue;
      }
      if (!/\.(?:ts|js|mjs|cjs|json|md)$/.test(entry.name)) continue;
      const text = await readFile(path, 'utf8');
      scanned += 1;
      for (const api of REMOVED_TYPEBOX_APIS) {
        // Match real member access, not prose mentioning the identifier.
        if (new RegExp(`\\b${api.replace('.', '\\.')}\\s*\\(`).test(text)) {
          throw new Error(`${label}: packed file ${path} uses removed TypeBox API ${api}`);
        }
      }
    }
  }
  if (scanned === 0) throw new Error(`${label}: scanned no packed files`);
}

function assertBundledTypeBox(temp: string, version: string, expectedRange: string): void {
  // The package must resolve Pi's bundled typebox, never a private copy.
  const nested = join(temp, 'node_modules', 'pi-background-tasks', 'node_modules', 'typebox');
  if (existsSync(nested))
    throw new Error(
      `Pi ${version}: package must not ship or install a private typebox at ${nested}`,
    );
  const hoisted = join(temp, 'node_modules', 'typebox', 'package.json');
  if (!existsSync(hoisted)) throw new Error(`Pi ${version}: typebox peer was not installed`);
  const parsed = parseJsonText(readFileSync(hoisted, 'utf8'));
  if (!isRecord(parsed)) throw new Error('typebox package.json must be an object');
  const installed = requireString(parsed['version'], 'typebox version');
  if (!installed.startsWith(expectedRange))
    throw new Error(`Pi ${version}: expected typebox ${expectedRange}x, resolved ${installed}`);
  console.log(`  Pi ${version}: typebox ${installed} (peer, not bundled)`);
}

/** Every supported Pi line must expose native Anthropic breakpoints for attribution to normalize. */
function assertAnthropicCacheAdapterSupport(temp: string, version: string): void {
  const candidates = [
    join(temp, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'api', 'anthropic-messages.js'),
    join(
      temp,
      'node_modules',
      '@earendil-works',
      'pi-coding-agent',
      'node_modules',
      '@earendil-works',
      'pi-ai',
      'dist',
      'api',
      'anthropic-messages.js',
    ),
  ];
  const adapterPath = candidates.find((path) => existsSync(path));
  if (adapterPath === undefined) {
    throw new Error(`Pi ${version}: installed Anthropic adapter source is missing`);
  }
  const source = readFileSync(adapterPath, 'utf8');
  for (const required of [
    'cache_control',
    'supportsLongCacheRetention',
    'supportsCacheControlOnTools',
    'PI_CACHE_RETENTION',
  ]) {
    if (!source.includes(required)) {
      throw new Error(`Pi ${version}: Anthropic adapter lacks required cache contract ${required}`);
    }
  }
}

/** Exact TypeBox line bundled by each supported Pi release. */
const TYPEBOX_BY_PI_VERSION: Record<
  RequiredPiVersion,
  { readonly spec: string; readonly prefix: string }
> = {
  '0.81.1': { spec: 'typebox@~1.1.38', prefix: '1.1.' },
  '0.82.1': { spec: 'typebox@~1.1.38', prefix: '1.1.' },
  '0.83.0': { spec: 'typebox@1.3.7', prefix: '1.3.' },
  '0.84.0': { spec: 'typebox@1.3.7', prefix: '1.3.' },
};

function expectedTypeBoxLine(
  version: RequiredPiVersion,
): (typeof TYPEBOX_BY_PI_VERSION)[RequiredPiVersion] {
  return TYPEBOX_BY_PI_VERSION[version];
}

async function smokeVersion(version: RequiredPiVersion, tarballPath: string): Promise<void> {
  const temp = await mkdtemp(join(tmpdir(), `pi-bg-compat-${version}-`));
  const typebox = expectedTypeBoxLine(version);
  try {
    run('npm', ['init', '-y'], temp);
    run(
      'npm',
      [
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        tarballPath,
        `@earendil-works/pi-coding-agent@${version}`,
        `@earendil-works/pi-tui@${version}`,
        typebox.spec,
      ],
      temp,
    );
    assertBundledTypeBox(temp, version, typebox.prefix);
    assertAnthropicCacheAdapterSupport(temp, version);
    await assertNoRemovedTypeBoxApis(
      join(temp, 'node_modules', 'pi-background-tasks'),
      `Pi ${version}`,
    );
    const cli = join(temp, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js');
    const extension = join(
      temp,
      'node_modules',
      'pi-background-tasks',
      'extensions',
      'background-tasks.ts',
    );
    if (!existsSync(cli)) throw new Error(`Pi CLI not installed for ${version}: ${cli}`);
    if (!existsSync(extension))
      throw new Error(`package extension missing for ${version}: ${extension}`);
    const agentDir = join(temp, 'agent');
    await mkdir(agentDir, { recursive: true });
    const scriptedProviderPath = join(
      root,
      'tests',
      'scripted-provider',
      'scripted-provider-extension.ts',
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...isolatedTestEnv,
      PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: join(temp, 'sessions'),
      PI_BG_SCRIPTED_API_KEY: 'scripted-api-key',
      PI_BG_SCRIPTED_SCENARIO: 'display-only-bg',
    };
    run(
      process.execPath,
      [
        cli,
        '--no-extensions',
        '-e',
        extension,
        '--offline',
        '--no-tools',
        '--no-session',
        '-p',
        '/jobs',
      ],
      temp,
      env,
    );
    await runRpcPromptUntil(
      process.execPath,
      [
        cli,
        '--mode',
        'rpc',
        '--no-extensions',
        '-e',
        scriptedProviderPath,
        '-e',
        extension,
        '--offline',
        '--no-tools',
        '--no-session',
        '--model',
        'pi-bg-scripted/scripted-model',
      ],
      temp,
      env,
      '/bg node -e "console.log(123)"',
      /background-task-notification.*completed/s,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

verifyTypeBoxPeerPosture();
const pack = parsePack(run('npm', ['pack', '--json'], root));
const tarballPath = join(root, pack.filename);
try {
  for (const version of requiredVersions) await smokeVersion(version, tarballPath);
  console.log(`Smoke-loaded background commands against Pi ${requiredVersions.join(', ')}`);
} finally {
  await rm(tarballPath, { force: true });
}
