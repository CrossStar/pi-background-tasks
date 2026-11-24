---
doc_id: read-before-edit
audience: agent
mode: generated
review_policy: contract
stability: stable
covers_surfaces: []
covers_sources: []
---
# Read before editing production sources

Every production file under `src/**` and `extensions/**` has exactly one primary behavioral documentation owner. This file is generated from authored ownership frontmatter and owns no production source itself.

## Source ownership

| Source | Primary behavioral owner |
| --- | --- |
| `extensions/anthropic-attribution.ts` | [subsystems/anthropic-attribution](./subsystems/anthropic-attribution.md) |
| `extensions/background-tasks.ts` | [subsystems/host-ui-and-telemetry](./subsystems/host-ui-and-telemetry.md) |
| `src/core/anthropic-attribution-path.ts` | [subsystems/anthropic-attribution](./subsystems/anthropic-attribution.md) |
| `src/core/anthropic-attribution.ts` | [subsystems/anthropic-attribution](./subsystems/anthropic-attribution.md) |
| `src/core/attested-pi-run.ts` | [subsystems/attested-pi-runs](./subsystems/attested-pi-runs.md) |
| `src/core/common.ts` | [subsystems/background-task-runtime](./subsystems/background-task-runtime.md) |
| `src/core/completion-receipt.ts` | [subsystems/host-ui-and-telemetry](./subsystems/host-ui-and-telemetry.md) |
| `src/core/durable-fs.ts` | [subsystems/child-launch-durability-and-safety](./subsystems/child-launch-durability-and-safety.md) |
| `src/core/execution-backend.ts` | [api/execution-backends-v1](./api/execution-backends-v1.md) |
| `src/core/extension-api.ts` | [api/eventbus-v1](./api/eventbus-v1.md) |
| `src/core/monitor-exclusion.ts` | [subsystems/background-task-runtime](./subsystems/background-task-runtime.md) |
| `src/core/persistent-runtime.ts` | [PERSISTENT-REMOTE](./PERSISTENT-REMOTE.md) |
| `src/core/pi-launch.ts` | [subsystems/child-launch-durability-and-safety](./subsystems/child-launch-durability-and-safety.md) |
| `src/core/registry.ts` | [subsystems/background-task-runtime](./subsystems/background-task-runtime.md) |
| `src/core/remote-persistent.ts` | [PERSISTENT-REMOTE](./PERSISTENT-REMOTE.md) |
| `src/core/update-check.ts` | [subsystems/host-ui-and-telemetry](./subsystems/host-ui-and-telemetry.md) |
| `src/core/windows-taskkill.ts` | [subsystems/background-task-runtime](./subsystems/background-task-runtime.md) |
| `src/extension.ts` | [subsystems/host-ui-and-telemetry](./subsystems/host-ui-and-telemetry.md) |
| `src/persistent/client.ts` | [subsystems/persistent-runtime](./subsystems/persistent-runtime.md) |
| `src/persistent/daemon.mjs` | [subsystems/persistent-runtime](./subsystems/persistent-runtime.md) |
| `src/persistent/log-sources.mjs` | [subsystems/persistent-runtime](./subsystems/persistent-runtime.md) |
| `src/persistent/remote-bridge.mjs` | [subsystems/persistent-runtime](./subsystems/persistent-runtime.md) |
| `src/persistent/shared.d.mts` | [subsystems/persistent-runtime](./subsystems/persistent-runtime.md) |
| `src/persistent/shared.mjs` | [subsystems/persistent-runtime](./subsystems/persistent-runtime.md) |
| `src/persistent/slurm-watch.mjs` | [subsystems/persistent-runtime](./subsystems/persistent-runtime.md) |
| `src/persistent/supervisor.mjs` | [subsystems/persistent-runtime](./subsystems/persistent-runtime.md) |
| `src/persistent/windows-tree.mjs` | [subsystems/persistent-runtime](./subsystems/persistent-runtime.md) |
| `src/ui/background-tasks-manager.ts` | [subsystems/host-ui-and-telemetry](./subsystems/host-ui-and-telemetry.md) |
| `src/ui/log-search.ts` | [subsystems/host-ui-and-telemetry](./subsystems/host-ui-and-telemetry.md) |
| `src/ui/sanitize-display.ts` | [subsystems/host-ui-and-telemetry](./subsystems/host-ui-and-telemetry.md) |

## Public surfaces

- `command:bg`
- `command:bg-clear`
- `command:bg-tasks`
- `command:bg-update`
- `command:bg_forget`
- `command:claude-cache`
- `command:jobs`
- `command:kill`
- `command:logs`
- `command:tasks`
- `eventbus:background-task-v1`
- `renderer:background-task-notification`
- `shortcut:ctrl+alt+c`
- `shortcut:shift+down`
- `tool:bg_kill`
- `tool:bg_logs`
- `tool:bg_run`
- `tool:bg_run_pi_attested`
- `tool:bg_status`
