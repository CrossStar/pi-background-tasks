import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseJsonText } from '../../src/core/common.js';

// npm ships as npm.cmd on Windows, and spawnSync with shell:false does not
// consult PATHEXT, so spawning the bare name yields status null with no child.
// Resolving npm's own JavaScript entry and running it through the current Node
// executable avoids the shim without introducing shell:true, mirroring how
// production resolves the Pi bin.
function resolveNpmCli(): string {
  const nodeDir = dirname(process.execPath);
  const candidates = [
    join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`cannot resolve npm-cli.js near ${process.execPath}`);
}

const npmCli = resolveNpmCli();

function runNpm(
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd: options.cwd,
    encoding: 'utf8',
    env: options.env,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

interface PackageJson {
  name: string;
  type: string;
  keywords: string[];
  pi: { extensions: string[]; image?: string | undefined };
  scripts: Record<string, string>;
  files: string[];
  peerDependencies: Record<string, string>;
  dependencies?: Record<string, string> | undefined;
  devDependencies?: Record<string, string> | undefined;
}

interface NpmPackFile {
  path: string;
}

interface NpmPackEntry {
  filename: string;
  files: NpmPackFile[];
}

interface SourceViolation {
  file: string;
  rule: string;
  excerpt: string;
}

const root = new URL('../../', import.meta.url);

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

function field(value: object, key: string): unknown {
  const property: unknown = Reflect.get(value, key);
  return property;
}

function parseJsonValue(text: string): unknown {
  return parseJsonText(text);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`);
  return value;
}

function requireStringArray(value: unknown, label: string): string[] {
  assert.ok(Array.isArray(value), `${label} must be an array`);
  assert.ok(
    value.every((item) => typeof item === 'string'),
    `${label} must contain strings`,
  );
  return value;
}

function parsePackageJson(value: unknown): PackageJson {
  assert.ok(isObject(value), 'package.json must be an object');
  const name = requireString(field(value, 'name'), 'name');
  const type = requireString(field(value, 'type'), 'type');
  const pi = field(value, 'pi');
  const scripts = field(value, 'scripts');
  const peerDependencies = field(value, 'peerDependencies');
  assert.ok(isObject(pi));
  assert.ok(isObject(scripts));
  assert.ok(isObject(peerDependencies));
  return {
    name,
    type,
    keywords: requireStringArray(field(value, 'keywords'), 'keywords'),
    pi: {
      extensions: requireStringArray(field(pi, 'extensions'), 'pi.extensions'),
      image: typeof field(pi, 'image') === 'string' ? (field(pi, 'image') as string) : undefined,
    },
    scripts: Object.fromEntries(
      Object.entries(scripts).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    ),
    files: requireStringArray(field(value, 'files'), 'files'),
    peerDependencies: Object.fromEntries(
      Object.entries(peerDependencies).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    ),
    dependencies: stringRecordField(value, 'dependencies'),
    devDependencies: stringRecordField(value, 'devDependencies'),
  };
}

function stringRecordField(value: object, key: string): Record<string, string> | undefined {
  const raw = field(value, key);
  if (raw === undefined) return undefined;
  assert.ok(isObject(raw), `${key} must be an object`);
  return Object.fromEntries(
    Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

async function pkg(): Promise<PackageJson> {
  return parsePackageJson(parseJsonValue(await readFile(new URL('package.json', root), 'utf8')));
}

async function text(file: string): Promise<string> {
  return readFile(new URL(file, root), 'utf8');
}

async function walkSourceTree(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walkSourceTree(path)));
    else if (/\.ts$/.test(entry.name)) files.push(path);
  }
  return files;
}

async function readMarkdownTree(dir: string): Promise<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  const parts: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) parts.push(await readMarkdownTree(path));
    else if (entry.name.endsWith('.md')) parts.push(await readFile(path, 'utf8'));
  }
  return parts.join('\n');
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function compactExcerpt(source: string): string {
  return source.replace(/\s+/g, ' ').trim().slice(0, 180);
}

function isPathLikeParameter(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === 'path' || lower === 'file' || lower.endsWith('path');
}

function isPathSyncHelperName(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.startsWith('write') || lower.startsWith('replace')) return false;
  if (
    lower === 'fsync' ||
    lower === 'sync' ||
    lower === 'fsyncfile' ||
    lower === 'fsyncpath' ||
    lower === 'syncfile' ||
    lower === 'syncpath'
  )
    return true;
  if (lower.includes('fsync') && (lower.includes('file') || lower.includes('path'))) return true;
  return lower.startsWith('sync') && (lower.includes('file') || lower.includes('path'));
}

function addPatternViolations(
  violations: SourceViolation[],
  file: string,
  rule: string,
  source: string,
  pattern: RegExp,
): void {
  for (const match of source.matchAll(pattern)) {
    violations.push({ file, rule, excerpt: compactExcerpt(match[0] ?? '') });
  }
}

function addExportedPathSyncViolations(
  violations: SourceViolation[],
  file: string,
  source: string,
): void {
  const exportedFunction =
    /\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*)\b/g;
  for (const match of source.matchAll(exportedFunction)) {
    const name = match[1];
    const parameter = match[2];
    if (
      name !== undefined &&
      parameter !== undefined &&
      isPathSyncHelperName(name) &&
      isPathLikeParameter(parameter)
    ) {
      violations.push({
        file,
        rule: 'exported path sync helper',
        excerpt: compactExcerpt(match[0]),
      });
    }
  }

  const exportedConst =
    /\bexport\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(?\s*([A-Za-z_$][\w$]*)\b/g;
  for (const match of source.matchAll(exportedConst)) {
    const name = match[1];
    const parameter = match[2];
    if (
      name !== undefined &&
      parameter !== undefined &&
      isPathSyncHelperName(name) &&
      isPathLikeParameter(parameter)
    ) {
      violations.push({
        file,
        rule: 'exported path sync helper',
        excerpt: compactExcerpt(match[0]),
      });
    }
  }

  const exportedList = /\bexport\s*\{([^}]*)\}/g;
  for (const match of source.matchAll(exportedList)) {
    const names = match[1];
    if (names !== undefined && names.split(',').some((name) => isPathSyncHelperName(name.trim()))) {
      violations.push({
        file,
        rule: 'exported path sync helper',
        excerpt: compactExcerpt(match[0]),
      });
    }
  }
}

function addSwallowedSyncViolations(
  violations: SourceViolation[],
  file: string,
  source: string,
): void {
  const syncTryCatch =
    /try\s*\{(?:(?!\}\s*catch)[\s\S])*?\.sync\s*\([^)]*\)[\s\S]*?\}\s*catch\s*(?:\([^)]*\))?\s*\{([\s\S]*?)\}/g;
  for (const match of source.matchAll(syncTryCatch)) {
    const body = match[1] ?? '';
    const trimmed = body.trim();
    const recordsFailure =
      /failure\(\s*['"]sync_(?:file|directory)['"]/.test(body) || /throwDurable\b/.test(body);
    const throwsImmediately = /^throw\b/.test(trimmed);
    if (
      trimmed.length === 0 ||
      /\breturn\b/.test(body) ||
      (!recordsFailure && !throwsImmediately)
    ) {
      violations.push({ file, rule: 'silent sync catch', excerpt: compactExcerpt(match[0] ?? '') });
    }
  }
}

function formatSourceViolations(violations: readonly SourceViolation[]): string {
  return violations
    .map((violation) => `${violation.file} ${violation.rule}: ${violation.excerpt}`)
    .join('\n');
}

function makeIsolatedEnvRoot(prefix: string): string {
  const rootDir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(rootDir, 'home'), { recursive: true });
  mkdirSync(join(rootDir, 'cache'), { recursive: true });
  mkdirSync(join(rootDir, 'config'), { recursive: true });
  return rootDir;
}

function removeIsolatedEnvRoot(rootDir: string): void {
  rmSync(rootDir, { recursive: true, force: true });
}

function isolatedNpmEnv(rootDir: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env['PATH'] ?? '',
    HOME: join(rootDir, 'home'),
    USERPROFILE: join(rootDir, 'home'),
    XDG_CONFIG_HOME: join(rootDir, 'config'),
    NPM_CONFIG_CACHE: join(rootDir, 'cache'),
    NPM_CONFIG_USERCONFIG: join(rootDir, 'npmrc'),
    NPM_CONFIG_REGISTRY: 'http://127.0.0.1.invalid/',
    npm_config_cache: join(rootDir, 'cache'),
    npm_config_userconfig: join(rootDir, 'npmrc'),
    PI_OFFLINE: '1',
    PI_SKIP_VERSION_CHECK: '1',
    PI_TELEMETRY: '0',
    CI: '1',
  };
}

function offlineNpmEnv(rootDir: string): NodeJS.ProcessEnv {
  const env = isolatedNpmEnv(rootDir);
  const home = process.env['HOME'] ?? process.env['USERPROFILE'];
  const cache =
    process.env['NPM_CONFIG_CACHE'] ?? (home === undefined ? undefined : join(home, '.npm'));
  if (cache === undefined)
    throw new Error('npm cache path is required for offline package install');
  env['NPM_CONFIG_CACHE'] = cache;
  env['npm_config_cache'] = cache;
  env['NPM_CONFIG_REGISTRY'] = 'https://registry.npmjs.org/';
  return env;
}

function parsePackEntries(stdout: string): NpmPackEntry[] {
  const trimmed = stdout.trim();
  const arrayStart = trimmed.startsWith('[') ? 0 : stdout.lastIndexOf('\n[') + 1;
  assert.ok(
    arrayStart > 0 || trimmed.startsWith('['),
    `npm pack output must end with a JSON array; received ${JSON.stringify(stdout.slice(0, 160))}`,
  );
  const parsed = parseJsonValue(arrayStart === 0 ? trimmed : stdout.slice(arrayStart).trim());
  assert.ok(Array.isArray(parsed), 'npm pack output must be an array');
  return parsed.map((entry): NpmPackEntry => {
    assert.ok(isObject(entry), 'pack entry must be an object');
    const filename = requireString(field(entry, 'filename'), 'pack filename');
    const files = field(entry, 'files');
    assert.ok(Array.isArray(files), 'pack entry files must be an array');
    return {
      filename,
      files: files.map((file): NpmPackFile => {
        assert.ok(isObject(file), 'pack file must be an object');
        const path = requireString(field(file, 'path'), 'pack file path');
        return { path };
      }),
    };
  });
}

void describe('package', () => {
  void it('manifest/docs cover public extension surfaces', async () => {
    const p = await pkg();
    assert.equal(p.name, 'pi-background-tasks');
    assert.equal(p.type, 'module');
    assert.ok(p.keywords.includes('pi-package'));
    assert.ok(p.keywords.includes('pi-extension'));
    assert.deepEqual(p.pi.extensions, [
      './extensions/anthropic-attribution.ts',
      './extensions/background-tasks.ts',
    ]);
    assert.equal(
      p.pi.image,
      'https://raw.githubusercontent.com/ismailsaleekh/pi-background-tasks/main/logo.png',
    );
    assert.match(p.scripts['test:agent-loop'] ?? '', /scripted-provider/);
    assert.match(p.scripts['test:full'] ?? '', /test:agent-loop/);
    assert.match(p.scripts['test:compat'] ?? '', /test-compat/);
    assert.match(p.scripts['test:pnpm-pack'] ?? '', /test-pnpm-pack-install/);
    assert.ok(p.files.includes('extensions/'));
    assert.ok(p.files.includes('src/'));
    assert.ok(p.files.includes('docs/'));
    assert.ok(p.files.includes('docs/BACKGROUND-TASKS-INSTRUCTIONS.md'));
    assert.ok(p.files.includes('docs/THIRD_PARTY_NOTICES.md'));
    assert.ok(p.files.includes('logo.png'));
    assert.ok(!p.files.includes('scripts/'));
    assert.equal(p.scripts['docs:generate'], 'node scripts/docs/generate.mjs');
    assert.equal(p.scripts['docs:verify'], 'node scripts/docs/verify.mjs');
    assert.match(p.scripts['prepack'] ?? '', /docs:verify/);
    assert.match(p.scripts['prepack'] ?? '', /payload:check/);
    assert.ok(p.peerDependencies['@earendil-works/pi-coding-agent']);
    assert.ok(p.peerDependencies['@earendil-works/pi-tui']);
    assert.ok(p.peerDependencies['typebox']);
    for (const f of [
      'README.md',
      'docs/BACKGROUND-TASKS-INSTRUCTIONS.md',
      'logo.png',
      'docs/TESTING.md',
      'docs/TEST_PLAN.md',
      'docs/PUBLISHING.md',
      'LICENSE',
      'docs/THIRD_PARTY_NOTICES.md',
      'src/extension.ts',
      'src/ui/background-tasks-manager.ts',

      'src/core/common.ts',
      'src/core/registry.ts',
      'src/core/extension-api.ts',
      'src/core/attested-pi-run.ts',
      'src/core/anthropic-attribution.ts',
      'src/core/anthropic-attribution-path.ts',
      'src/core/pi-launch.ts',

      'extensions/anthropic-attribution.ts',
      'extensions/background-tasks.ts',

    ])
      assert.ok(existsSync(new URL(f, root)), f);

    const readme = await text('README.md');
    const documentationInventory = `${readme}\n${await readMarkdownTree(fileURLToPath(new URL('docs/', root)))}`;
    const plan = await text('docs/TEST_PLAN.md');
    for (const surface of [
      '/bg',
      '/jobs',
      '/logs',
      '/kill',
      '/tasks',
      '/bg-tasks',
      '/bg-clear',
      '/bg-update',
      '/claude-cache',
      'bg_run',

      'bg_run_pi_attested',
      'bg_status',
      'bg_logs',
      'bg_kill',
      'pi-background-tasks:request:v1',
      'pi-background-tasks:response:v1',
      'pi-background-tasks:terminal:v1',

    ]) {
      assert.match(
        documentationInventory,
        new RegExp(surface.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        `README/generated docs inventory missing ${surface}`,
      );
      assert.match(
        plan,
        new RegExp(surface.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        `TEST_PLAN missing ${surface}`,
      );
    }
    const eventBusDocs = await text('docs/api/eventbus-v1.md');
    assert.match(eventBusDocs, /src\/core\/extension-api\.ts/);
    const shortcutDocs = await text('docs/reference/shortcuts-and-dock.md');
    assert.match(shortcutDocs, /Shift\+Down/);
    assert.match(shortcutDocs, /Ctrl\+Alt\+C/);
  });

  void it('ships global package-owned Anthropic attribution with no exotic dependency', async () => {
    const p = await pkg();
    assert.equal(p.dependencies?.['@ravshansbox/pi-anthropic-sps'], undefined);
    for (const [name, specifier] of Object.entries(p.dependencies ?? {})) {
      assert.doesNotMatch(
        specifier,
        /^(?:https?:|git(?:\+|:)|github:|file:)/,
        `production dependency ${name} must use a registry version`,
      );
    }
    const attribution = await text('src/core/anthropic-attribution.ts');
    assert.match(attribution, /X-Claude-Code-Session-Id/);
    assert.match(attribution, /prompt-caching-scope-2026-01-05/);
    assert.match(attribution, /cacheWrite1h/);
    assert.match(attribution, /CLAUDE_CODE_200K_SUBSCRIPTION_CONTEXT_WINDOW/);
    assert.match(attribution, /environment variables \(docs\/environment-variables\.md\)/);
    assert.match(attribution, /ANTHROPIC_ATTRIBUTION_CLAIM_CHANNEL/);
  });

  void it('keeps production durable syncing handle-scoped and loud', async () => {
    const files = await walkSourceTree(fileURLToPath(new URL('src/', root)));
    const violations: SourceViolation[] = [];
    for (const file of files) {
      const source = stripComments(await readFile(file, 'utf8'));
      // file is a native path from walkSourceTree, so the prefix must be native
      // too. Comparing against a URL pathname silently never matches on Windows.
      const rootPath = fileURLToPath(root);
      const label = file.startsWith(rootPath) ? file.slice(rootPath.length) : file;
      addPatternViolations(
        violations,
        label,
        'read-open sync',
        source,
        /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:nodeOpen|open|fs(?:Promises)?\.open|[A-Za-z_$][\w$]*\.openWritable)\s*\([^;]*,\s*(['"])r\+?\2[^;]*\)\s*;?[\s\S]*?\b\1\s*\.\s*sync\s*\(/g,
      );
      addPatternViolations(
        violations,
        label,
        'read-open sync',
        source,
        /\b([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:nodeOpen|open|fs(?:Promises)?\.open|[A-Za-z_$][\w$]*\.openWritable)\s*\([^;]*,\s*(['"])r\+?\2[^;]*\)\s*;?[\s\S]*?\b\1\s*\.\s*sync\s*\(/g,
      );
      addPatternViolations(
        violations,
        label,
        'fsyncFile function',
        source,
        /\b(?:async\s+)?function\s+fsyncFile\b|\b(?:const|let|var)\s+fsyncFile\s*=/g,
      );
      addExportedPathSyncViolations(violations, label, source);
      addSwallowedSyncViolations(violations, label, source);
    }
    assert.equal(violations.length, 0, formatSourceViolations(violations));
  });

  void it('converts file URLs to native paths instead of using URL.pathname', async () => {
    // On Windows `new URL(...).pathname` yields `/D:/a/repo/`, and joining that
    // produces `D:\D:\a\repo\...`, which fails with ENOENT. CI proved this.
    // `fileURLToPath` is the only correct conversion.
    const roots = ['src', 'extensions', 'scripts', 'tests'];
    const offenders: string[] = [];
    for (const rootDir of roots) {
      const dir = fileURLToPath(new URL(`${rootDir}/`, root));
      if (!existsSync(dir)) continue;
      for (const file of await walkSourceTree(dir)) {
        const source = await readFile(file, 'utf8');
        const stripped = source
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .split('\n')
          .filter((line) => !line.trim().startsWith('//'))
          .join('\n');
        // Matches both the inline form new URL(...).pathname and the indirect
        // form where the URL is bound to a variable and read later. The indirect
        // form previously escaped this guard and reached Windows CI.
        const inlinePathname = /new URL\([^)]*\)\s*\.pathname/.test(stripped);
        const urlBindings = [...stripped.matchAll(/\b(\w+)\s*=\s*new URL\(/g)].map(
          (match) => match[1],
        );
        const indirectPathname = urlBindings.some(
          (binding) =>
            binding !== undefined && new RegExp(`\\b${binding}\\s*\\.pathname\\b`).test(stripped),
        );
        if (inlinePathname || indirectPathname) offenders.push(file);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      'use fileURLToPath(new URL(...)) so Windows paths resolve correctly',
    );
  });

  void it('typechecks standalone with the full monorepo strictness vendored locally', async () => {
    // The package is published both from this monorepo and as a standalone git
    // repo. A parent `../../tsconfig.base.json` does not exist in the standalone
    // checkout, so `extends` must point at a locally vendored copy. CI proved
    // that a missing base silently drops `skipLibCheck` and makes `tsc` walk
    // node_modules type definitions.
    const tsconfig = parseJsonValue(await text('tsconfig.json'));
    assert.ok(isObject(tsconfig));
    assert.equal(
      field(tsconfig, 'extends'),
      './tsconfig.base.json',
      'tsconfig must extend a locally vendored base so standalone checkouts typecheck',
    );

    const localBase = parseJsonValue(await text('tsconfig.base.json'));
    assert.ok(isObject(localBase));
    const localOptions = field(localBase, 'compilerOptions');
    assert.ok(isObject(localOptions));

    // Every strictness flag from the monorepo base must be present and equal.
    // Weakening the standalone config to make a build pass is not acceptable.
    const required: Record<string, boolean> = {
      strict: true,
      exactOptionalPropertyTypes: true,
      noUncheckedIndexedAccess: true,
      noImplicitOverride: true,
      noImplicitReturns: true,
      noPropertyAccessFromIndexSignature: true,
      noFallthroughCasesInSwitch: true,
      noUnusedLocals: true,
      noUnusedParameters: true,
      useUnknownInCatchVariables: true,
      verbatimModuleSyntax: true,
      isolatedModules: true,
      allowUnreachableCode: false,
      allowUnusedLabels: false,
      skipLibCheck: true,
    };
    for (const [flag, expected] of Object.entries(required)) {
      assert.equal(
        field(localOptions, flag),
        expected,
        `vendored tsconfig.base.json must keep ${flag}=${String(expected)}`,
      );
    }
  });

  void it('packs exactly the runtime/docs payload and excludes tests/artifacts', () => {
    const envRoot = makeIsolatedEnvRoot('pi-bg-pack-env-');
    const r = runNpm(['pack', '--dry-run', '--json'], {
      cwd: fileURLToPath(root),
      env: isolatedNpmEnv(envRoot),
    });
    removeIsolatedEnvRoot(envRoot);
    assert.equal(r.status, 0, r.stderr);
    const firstEntry = parsePackEntries(r.stdout)[0];
    assert.ok(firstEntry, 'npm pack must return one entry');
    const files = firstEntry.files.map((file) => file.path).sort();
    for (const f of [
      'extensions/anthropic-attribution.ts',
      'extensions/background-tasks.ts',

      'src/extension.ts',

      'src/core/common.ts',
      'src/core/registry.ts',
      'src/core/anthropic-attribution.ts',
      'src/core/anthropic-attribution-path.ts',
      'src/core/extension-api.ts',
      'src/core/attested-pi-run.ts',
      'src/core/pi-launch.ts',
      'src/ui/background-tasks-manager.ts',

      'README.md',
      'docs/BACKGROUND-TASKS-INSTRUCTIONS.md',
      'logo.png',
      'docs/TESTING.md',
      'docs/TEST_PLAN.md',
      'docs/PUBLISHING.md',
      'LICENSE',
      'docs/THIRD_PARTY_NOTICES.md',
      'docs/INDEX.md',
      'docs/read-before-edit.md',
      'docs/manifest.json',
      'docs/attestations.json',
      'docs/assets/architecture.svg',
      'docs/assets/footer-dock.svg',
      'docs/assets/logo.svg',
      'docs/subsystems/docs-freshness-gate.md',
      'package.json',
    ])
      assert.ok(files.includes(f), f);
    assert.ok(!files.some((f) => f.startsWith('tests/')), 'tests must not ship');
    assert.ok(!files.some((f) => f.startsWith('scripts/')), 'release-only scripts must not ship');
    assert.ok(!files.some((f) => f.includes('node_modules')), 'node_modules must not ship');
    assert.ok(!files.some((f) => f.endsWith('.tgz')), 'nested tarballs must not ship');
  });

  void it('local tarball installs with the expected package files', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'pi-bg-pack-'));
    let tarball: URL | undefined;
    const packEnvRoot = makeIsolatedEnvRoot('pi-bg-pack-env-');
    const installEnvRoot = makeIsolatedEnvRoot('pi-bg-install-env-');
    try {
      const pack = runNpm(['pack', '--json'], {
        cwd: fileURLToPath(root),
        env: isolatedNpmEnv(packEnvRoot),
      });
      assert.equal(pack.status, 0, pack.stderr);
      const firstEntry = parsePackEntries(pack.stdout)[0];
      assert.ok(firstEntry, 'npm pack must return one entry');
      tarball = new URL(firstEntry.filename, root);
      // fileURLToPath, never pathname: on Windows pathname yields a leading-slash
      // form such as /D:/... which is not a usable native path.
      const tarballPath = fileURLToPath(tarball);
      const init = runNpm(['init', '-y'], {
        cwd: temp,
        env: isolatedNpmEnv(installEnvRoot),
      });
      assert.equal(init.status, 0, init.stderr);
      const install = runNpm(
        [
          'install',
          '--legacy-peer-deps',
          '--offline',
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
          tarballPath,
        ],
        {
          cwd: temp,
          env: offlineNpmEnv(installEnvRoot),
        },
      );
      assert.equal(install.status, 0, install.stderr);
      assert.equal(
        existsSync(join(temp, 'node_modules', '@ravshansbox', 'pi-anthropic-sps')),
        false,
        'packed consumers must not install the retired URL-based sanitizer dependency',
      );
      assert.equal(
        existsSync(join(temp, 'node_modules', 'turndown', 'package.json')),
        false,
        'packed consumers must not install the removed research markdown dependency',
      );
      for (const f of [
        'package.json',
        'docs/BACKGROUND-TASKS-INSTRUCTIONS.md',
        'docs/THIRD_PARTY_NOTICES.md',
        'logo.png',
        'docs/INDEX.md',
        'docs/read-before-edit.md',
        'docs/manifest.json',
        'docs/attestations.json',
        'docs/assets/architecture.svg',
        'docs/assets/footer-dock.svg',
        'docs/assets/logo.svg',
        'extensions/anthropic-attribution.ts',
        'extensions/background-tasks.ts',

        'src/extension.ts',

        'src/core/registry.ts',
        'src/core/anthropic-attribution.ts',
        'src/core/anthropic-attribution-path.ts',
        'src/core/extension-api.ts',
        'src/core/attested-pi-run.ts',
        'src/core/pi-launch.ts',

        'src/ui/background-tasks-manager.ts',

      ]) {
        assert.ok(existsSync(join(temp, 'node_modules', 'pi-background-tasks', f)), f);
      }
    } finally {
      await rm(temp, { recursive: true, force: true });
      removeIsolatedEnvRoot(packEnvRoot);
      removeIsolatedEnvRoot(installEnvRoot);
      if (tarball) await rm(tarball, { force: true });
    }
  });
});
