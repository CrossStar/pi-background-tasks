---
doc_id: TESTING
audience: maintainer
mode: authored
review_policy: contract
stability: stable
covers_surfaces: []
covers_sources: []
---
# pi-background-tasks Testing

This package follows the package-local QA navigation docs:

- `docs/BACKGROUND-TASKS-INSTRUCTIONS.md` — required agent gateway/read order
- [`docs/operations/testing.md`](operations/testing.md) — gate selection and isolation
- [`docs/TEST_PLAN.md`](TEST_PLAN.md) — exhaustive feature coverage matrix and acceptance truth

The historical monorepo extension standards are contextual background only; do not leave standalone package links to parent `../EXTENSION_*` files in this package's published docs.

## Current commands

Default gate:

```bash
npm run test
```

This runs:

```bash
npm run typecheck
npm run test:type-safety
npm run test:unit
npm run test:sdk
npm run test:rpc
npm run test:component
npm run test:package
```

Full interactive gate:

```bash
npm run test:full
```

This runs the default gate plus:

```bash
npm run test:pty
npm run test:agent-loop
```

Smoke/release checks:

```bash
npm run smoke
npm run pack:dry-run
npm run test:compat
```

Current smoke is `tsx scripts/smoke.ts`. It creates a temporary Pi agent/session directory, sets offline/telemetry-suppression environment variables, and runs the package entrypoint with `/jobs`.


Compatibility checks install the supported Pi versions, verify TypeBox peer identity and Anthropic attribution, load `/jobs`, and complete a real `/bg` task.

Smoke proves loadability only; completion requires `npm run test`, `npm run test:full`, `npm run pack:dry-run`, and the release-only compatibility gate when preparing a release.

### Docs/gateway focused checks

Current package docs gates are `npm run docs:generate` and `npm run docs:verify`; semantic receipt freshness is advisory there. Use `npm run docs:verify:attestations` only when a release or operator explicitly requires fresh independent receipts, and record them with `npm run docs:attest/record -- <doc_id> --reviewer <identity-after-semantic-review> --verdict PASS --notes <review-notes>`.

## Required isolated environment

Automated tests run with isolated temp project/agent/session directories and should use:

```bash
PI_OFFLINE=1
PI_SKIP_VERSION_CHECK=1
PI_TELEMETRY=0
CI=1
```

Tests must not use the user's real `~/.pi/agent`.



```bash
npm run typecheck
npm run test:type-safety
npm run test:unit
npm run test:component
npm run test:sdk
npm run test:rpc
npm run test:agent-loop
```


## Coverage summary

Implemented coverage includes:

- update-available notice: semver parse/compare/precedence, `formatUpdateSegment`, npm/`package.json` payload narrowing, and injected-fetch success/404/throw, silent timer-owned timeout abort, and loud independently sourced `AbortError` (unit); localhost-registry footer segment (idle + appended to an active footer), `/bg-update` non-installing instructions, and opt-out/offline/already-current/registry-failure no-segment-and-no-throw paths (SDK); `/bg-update` discovery and offline instructions (RPC). The check is one-shot on `session_start`, time-boxed, offline-safe, gated by `PI_OFFLINE`/`PI_BG_DISABLE_UPDATE_CHECK`, and `PI_BG_REGISTRY_URL` overrides the registry endpoint
- shortcut/UI: component coverage for focused dock list/detail/key handling, detail output-tail scrolling (arrow/page scroll, follow-pause-on-scroll, `lines X–Y of N` position indicator, resume-follow-at-bottom, and no-scroll when output fits), empty/history/unread states, paging, close aliases, stop/stop-all/rerun/path actions, missing output files; SDK coverage for explicit `/bg-clear` finished-notice clearing, `/bg-clear` footer hinting, optional `Ctrl+Alt+C` fallback shortcut registration, and mixed failed/stopped/done/focused footer status; RPC coverage that `/bg-clear` works as a terminal-independent clear path; and PTY coverage for `/tasks`, `/bg-tasks`, real `Shift+Down`, arrows, page keys, detail/back/history/stop/stop-all/rerun/path/close, failed unread badges, and running/completed/failed/killed rerun paths
- extension EventBus API: unit coverage for `pi-background-tasks:request:v1`/`response:v1` closed-frame validation, exact capability handshake, malformed payload rejection, unknown keys, unknown operations, duplicate request IDs, missing `session_start`, shutdown refusal, unsubscribe, strict terminal frame shape, and response-barrier ordering; registry coverage for one terminal publication after durable metadata when emit succeeds plus loud/retriable delivery failure. A retry after a listener throws can redeliver to an earlier listener, so consumers deduplicate by task id. SDK coverage uses a shared real `createEventBus()`, starts `printf api-ok`, reads bounded logs, observes one terminal event after the run response, and kills a real sleep task without model/provider calls
- attested Pi producer: unit/SDK coverage for 128-bit attested task ids, exact direct argv/cwd, explicit package attribution on Anthropic routes only, ModelRegistry OAuth observation without secrets, raw Pi session/message events, separate stderr, prompt/report/source hashes, authority start/finish commit/tree/clean checks, atomic metadata serialization, completion visibility only after the sidecar is durable, malformed event rejection, and no attestation sidecar for ordinary tasks
- agent activity transcript: pure `parseAgentActivity`/`formatAgentActivityLine` coverage (assistant text, reasoning, tool start with arg summary, silent successful tool end, `✗ tool failed` errors, truncation, invalid/non-activity narrowing); registry-unit coverage that wrapped-agent stdout is reconstructed across split chunks into the human-readable transcript while telemetry/activity control JSON is stripped from the output file (telemetry fields still updated), stderr passes through, and the trailing partial line is flushed on finalize; SDK coverage that fake and real child `pi --mode json` runs surface `→ tool`/`✗ tool failed`/assistant text in `bg_logs` with no control JSON leaking into the visible output
- safety: kill, already-finished kill failure, timeout failure, spawn failure, low output-cap failure, process-supervised extension-reload handoff for running tasks and terminal history, validated terminal shell-history restoration from metadata, multi-task quit/session-replacement cleanup, POSIX process-group kill fallback, Windows `taskkill /T` then `/T /F` tree termination with shared soft attempts, soft-abort-on-force, exit-128 race tolerance, loud force failures, no root-only fallback, SIGKILL escalation that terminates instead of re-arming (a SIGKILL never schedules a further escalation, and concurrent stop requests share exactly one escalation timer that is cleared on finalize), duplicate finalization/notification races, metadata/notification failure handling, and pruning
- package: manifest, docs, ordered `pi.extensions`, exported `src/core/extension-api.ts`, registry-only production dependencies, peer dependency/import parity, packed runtime files/notices, tarball-install smoke, direct-completion import bans, test/helper/script/artifact exclusion, isolated offline npm installation, exact-version compatibility

## PTY notes

`test:pty` uses `/usr/bin/expect` to drive a real pseudo-terminal. It verifies:

- `/tasks` and `/bg-tasks` open the focused dock and close with `x`.
- A named `/bg` task appears in the dock when opened with xterm `Shift+Down` (`ESC [ 1 ; 2 B`).
- Secondary dock keys work in a real TUI: arrows, page keys, detail/back, history, stop selected, stop-all confirmation, rerun, output path, and failed/unread history surfacing.
- Detail output-tail scrolling works with real arrow/page keys: opening a 60-line task's detail and pressing `↑` shows the `lines X–Y of N` position indicator and pauses the live tail.

The detail-view `Model:` line and the compact `model <id>` dock row are also exercised deterministically by the component layer (`tests/component/background-tasks-manager.test.ts`), which is the lowest reliable layer for dock rendering.

### Terminal keyboard-protocol negotiation

`pi` enables the Kitty keyboard protocol at startup by emitting `ESC[>7u ESC[?u ESC[c` and briefly intercepts stdin until that negotiation completes. The expect harness therefore must not key on a bare `>` (which matches the `ESC[>7u` push instantly and fires input before pi is listening); instead it waits for the steady-state status marker `(auto)`, answers the keyboard-protocol query (`ESC[?0u`, i.e. legacy keyboard) and the device-attributes query (`ESC[?1;2c`), and settles briefly before sending keys. This makes legacy keystrokes reach pi deterministically rather than racing the 150 ms negotiation fallback.

### Interactive-stdin capability probe

`test:pty` begins with a one-shot probe (`ptyInputSupported()`) that spawns a minimal raw-mode Node stdin reader under the same `/usr/bin/expect` driver and checks that a sent byte is received. Some hosts cannot deliver stdin to a raw-mode Node TUI through expect (a plain `cat` receives input but Node `process.stdin` does not). On such hosts every PTY case is skipped with a loud reason instead of failing; where stdin is deliverable the full interactive dock scenarios run for real. The deterministic SDK/RPC/component layers remain the authoritative gates in `npm run test` either way.

## Artifact policy

Use package-local or repo-level artifacts if future snapshot/log persistence is needed:

```text
artifacts/pi-extension-tests/pi-background-tasks/
├── summary.json
├── rpc-events.jsonl
├── tui-ansi.log
├── screen.normalized.txt
└── snapshots/
```

Normalize volatile values before snapshotting: task IDs, session IDs, PIDs, timestamps, durations, temp paths, and `.pi/tasks/<session-pid>/...` run directories.

## Remaining full exhaustive coverage work
