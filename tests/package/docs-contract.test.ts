import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url);

function text(path: string): string {
  return readFileSync(new URL(path, root), 'utf8');
}

void describe('docs package integration contract', () => {
  void it('declares docs scripts, prepack gates, and packaged docs payload', () => {
    const pkg = JSON.parse(text('package.json')) as {
      files: string[];
      scripts: Record<string, string>;
      pi?: { image?: string };
    };
    assert.ok(pkg.files.includes('docs/'));
    assert.ok(pkg.files.includes('docs/BACKGROUND-TASKS-INSTRUCTIONS.md'));
    assert.ok(pkg.files.includes('logo.png'));
    assert.equal(
      pkg.pi?.image,
      'https://raw.githubusercontent.com/CrossStar/pi-background-tasks/main/logo.png',
    );
    assert.equal(pkg.scripts['docs:generate'], 'node scripts/docs/generate.mjs');
    assert.equal(pkg.scripts['docs:verify'], 'node scripts/docs/verify.mjs');
    assert.equal(
      pkg.scripts['docs:verify:attestations'],
      'node scripts/docs/verify.mjs --require-attestations',
    );
    assert.equal(pkg.scripts['docs:attest/record'], 'node scripts/docs/attest.mjs');
    assert.equal(
      pkg.scripts['test:docs'],
      'tsx --test tests/unit/docs-gate.test.ts tests/package/docs-contract.test.ts',
    );
    assert.equal(pkg.scripts['payload:check'], 'node scripts/check-package-payload.mjs');
    assert.equal(pkg.scripts['release:check-version'], 'node scripts/check-release-version.mjs');
    assert.match(pkg.scripts['prepack'] ?? '', /docs:verify/);
    assert.match(pkg.scripts['prepack'] ?? '', /payload:check/);
    for (const path of [
      'docs/INDEX.md',
      'docs/read-before-edit.md',
      'docs/manifest.json',
      'docs/attestations.json',
      'docs/subsystems/docs-freshness-gate.md',
    ]) {
      assert.ok(existsSync(new URL(path, root)), `${path} must exist`);
    }
  });

  void it('pins reviewed runtime and generated artifact semantics', () => {
    assert.match(text('docs/commands/task-manager.md'), /exact task id opens detail view/);
    assert.match(text('docs/api/eventbus-v1.md'), /at least once under emission failure/);
    assert.match(text('docs/api/eventbus-v1.md'), /later requests are not handled/);
    assert.match(text('docs/subsystems/background-task-runtime.md'), /rather than issuing `fsync`/);
    assert.match(
      text('docs/subsystems/background-task-runtime.md'),
      /may occur after the completion notification/,
    );
    assert.match(
      text('docs/subsystems/attested-pi-runs.md'),
      /last assistant `stopReason` value reported/,
    );

    assert.match(text('docs/subsystems/host-ui-and-telemetry.md'), /detail view is opened/);
    assert.match(text('docs/subsystems/host-ui-and-telemetry.md'), /dock is closed/);
    assert.doesNotMatch(
      text('docs/reference/shortcuts-and-dock.md'),
      /Opening or closing the dock does not clear them/,
    );

  });
});
