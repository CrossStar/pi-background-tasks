---
doc_id: reference/runtime-contracts
audience: maintainer
mode: mixed
review_policy: contract
stability: evolving
covers_surfaces: []
covers_sources: []
---
# Runtime contracts reference

This generated registry lists production environment-variable references, runtime paths/artifacts, schema identifiers, and status vocabularies extracted from package source. It intentionally excludes incidental source-code literals such as package metadata import paths.

<!-- pi-docs:begin name="runtime-contracts" generator="scripts/docs/generate.mjs" -->
### Environment variable references

| Name | Access | Provenance |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | remove | `src/core/attested-pi-run.ts:135` |
| `ANTHROPIC_BASE_URL` | remove | `src/core/attested-pi-run.ts:135` |
| `ComSpec` | read | `src/core/common.ts:671`<br>`src/core/common.ts:682` |
| `OPENAI_API_KEY` | remove | `src/core/attested-pi-run.ts:135` |
| `OPENAI_BASE_URL` | remove | `src/core/attested-pi-run.ts:135` |
| `OPENROUTER_API_KEY` | remove | `src/core/attested-pi-run.ts:135` |
| `OPENROUTER_BASE_URL` | remove | `src/core/attested-pi-run.ts:135` |
| `path` | read | `src/core/common.ts:626` |
| `Path` | read | `src/core/common.ts:626` |
| `PATH` | read | `src/core/common.ts:626` |
| `PI_API_BASE_URL` | remove | `src/core/attested-pi-run.ts:135` |
| `PI_API_KEY` | remove | `src/core/attested-pi-run.ts:135` |
| `PI_AUTH_FILE` | remove | `src/core/attested-pi-run.ts:135` |
| `PI_BG_DISABLE_PI_TELEMETRY` | read | `src/core/registry.ts:212` |
| `PI_BG_DISABLE_UPDATE_CHECK` | read | `src/extension.ts:510` |
| `PI_BG_MAX_OUTPUT_BYTES` | read | `src/core/registry.ts:72` |
| `PI_BG_REGISTRY_URL` | read | `src/extension.ts:519` |
| `PI_BG_SHELL` | read | `src/core/common.ts:667` |
| `PI_BG_SHELL_PATH` | read | `src/core/common.ts:668` |
| `PI_BG_SOURCE_HEAD_BYTES` | read | `src/core/remote-persistent.ts:79` |
| `PI_BG_SOURCE_TAIL_BYTES` | read | `src/core/remote-persistent.ts:78` |
| `PI_CACHE_RETENTION` | read | `src/core/anthropic-attribution.ts:587` |
| `PI_OFFLINE` | read | `src/extension.ts:511` |
| `PIPELINE_ANTHROPIC_ATTRIBUTION_AUDIT_PATH` | read | `src/core/anthropic-attribution.ts:1013` |
| `SHELL` | read | `src/core/common.ts:663` |
| `SystemRoot` | read | `src/core/windows-taskkill.ts:96` |
| `WINDIR` | read | `src/core/windows-taskkill.ts:101` |

### Runtime paths and artifacts

| Kind | Path/artifact | Provenance |
| --- | --- | --- |
| directory | `.pi/tasks/<session-id>-<pid>/` | `src/core/registry.ts:966` |
| task-file | `.pi/tasks/<session-id>-<pid>/<task-id>.attestation.json` | `src/core/attested-pi-run.ts:592` |
| task-file | `.pi/tasks/<session-id>-<pid>/<task-id>.json` | `src/core/registry.ts:1191` |
| task-file | `.pi/tasks/<session-id>-<pid>/<task-id>.output` | `src/core/registry.ts:1254` |
| task-file | `.pi/tasks/<session-id>-<pid>/<task-id>.pi-events.jsonl` | `src/core/attested-pi-run.ts:589` |
| task-file | `.pi/tasks/<session-id>-<pid>/<task-id>.pi-telemetry-wrapper.cjs` | `src/core/attested-pi-run.ts:591` |
| task-file | `.pi/tasks/<session-id>-<pid>/<task-id>.stderr` | `src/core/attested-pi-run.ts:590` |

### Schema identifiers

| Schema | Provenance |
| --- | --- |
| `phase2.pi_task_attestation.v1` | `src/core/attested-pi-run.ts:20` |
| `pi-background-tasks.extension-request.v1` | `src/core/extension-api.ts:15` |
| `pi-background-tasks.extension-response.v1` | `src/core/extension-api.ts:16` |
| `pi-background-tasks.extension-terminal.v1` | `src/core/extension-api.ts:17` |
| `pi-background-tasks.monitor-exclusions.v1` | `src/core/monitor-exclusion.ts:6` |
| `pi-background-tasks.monitor-state.v2` | `src/core/registry.ts:763` |
| `pi-background-tasks.process-registry.v2` | `src/core/registry.ts:713` |

### Status vocabularies


```json
{
  "TASK_STATUS_VALUES": [
    "running",
    "completed",
    "failed",
    "killed"
  ],
  "TERMINAL_TASK_STATUS_VALUES": [
    "completed",
    "failed",
    "killed"
  ]
}
```
<!-- pi-docs:end name="runtime-contracts" -->

## Maintenance rule

If a runtime fact changes in source, update the owning subsystem/API doc and run `npm run docs:generate`. Do not hand-edit generated tables.
