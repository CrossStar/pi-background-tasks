---
doc_id: TEST_PLAN
audience: maintainer
mode: authored
review_policy: contract
stability: stable
covers_surfaces: []
covers_sources: []
---
# pi-background-tasks Test Plan

This package follows the package-local maintainer navigation:

- `docs/BACKGROUND-TASKS-INSTRUCTIONS.md` — required agent gateway/read order
- [`docs/operations/testing.md`](operations/testing.md) — gate selection and isolation
- [`docs/operations/releasing.md`](operations/releasing.md) — release/payload maintenance

The table below remains the exhaustive acceptance source. Do not replace it with a generic summary.

## Package

| Field | Value |
|---|---|
| Package | `pi-background-tasks` |
| Extension entrypoints | `extensions/anthropic-attribution.ts`, `extensions/background-tasks.ts` |
| Public commands | `/bg`, `/jobs`, `/logs`, `/kill`, `/tasks`, `/bg-tasks`, `/bg-clear`, `/bg_forget`, `/bg-update`, `/claude-cache` |
| Public tools | `bg_run`, `bg_run_pi_attested`, `bg_status`, `bg_logs`, `bg_kill` |
| Extension EventBus API | `pi-background-tasks:request:v1`, `pi-background-tasks:response:v1`, `pi-background-tasks:terminal:v1`; schemas exported from `src/core/extension-api.ts` |
| Shortcuts | `Shift+Down`; optional fallback `Ctrl+Alt+C` |
| Custom UI | footer status + focused bottom dock overlay |
| Custom provider | package-owned `anthropic` subscription-OAuth attribution transport; provider-gated, no non-Anthropic override |

## Execution backend lifecycle coverage

`tests/unit/execution-backend.test.ts` covers admission snapshots, local defaults, resolver rebinding, no fallback on discovery/spawn errors, confirmed cancellation versus unknown transport outcome, connecting-time timeout, disposal, and unsupported agent admission. `tests/sdk/sdk.test.ts` exercises the actual extension discovery/readiness events, provider conflicts, local log ownership, and agent rejection through both tools and the EventBus. External signal exits without a cancellation request must fail rather than report success. These fixtures do not replace Sydney's real SSH and jump-host lifecycle tests.

## Slurm monitor and log-source acceptance

`monitor-primitives.test.mjs` and `slurm-integration.test.mjs` use fake scheduler executables and temporary service roots. They cover restricted source reads, cursor replacement/truncation, command allow-list, empty/multi-record accounting, terminal success rules, settling, ownership, duplicate attachment, separate array indices, on-demand array logs and monitor-only cancellation. `source-mirrors.test.ts` checks incremental reuse, rotation and terminal head/tail windows. Component coverage checks source switching, merged physical rows, sanitization, width and pause/follow. Forget tests use a Slurm record and verify zero backend calls and owner/endpoint isolation. No real SSH or cluster job is exercised.

The review regressions also cover compressed pending arrays and heterogeneous accounting, malformed-row isolation, requeue during settling, empty-accounting diagnostics, single successful discovery, changed-only registration, glob caps/cache/disappearance, corrupt admissions, owner checks before manifest access, mirror transfer bounds, terminal/detach window release, and local dedupe placeholder removal. Source-mirror registry fixtures pin a temporary service root.

## Persistent task acceptance

Persistent local commands must survive the admitting Pi process, preserve their task ID and output path, and remain cancellable from a replacement process resuming the same session ID. A different or forked session in the same cwd must neither restore nor control them. Legacy records without an owner must not be implicitly claimed. Check both local and SSH list/get/log/cancel paths, including direct task-ID attempts and repeated start IDs with a conflicting owner. Run real process-boundary tests as well as SDK session replacement tests; constructing two registries in one process alone does not prove restart survival.

Required failure scenarios include daemon SIGKILL with a live supervisor, duplicate admission with a launch side-effect counter, offline timeout/output cap, cancellation before launch readiness, and unavailable supervisor control. Recovery must never execute a stored command again. Supervisor records own execution truth; Pi must not rewrite them with notification state. Offline completions and recovered running tasks must deliver opted-in notifications to the same owner session after it becomes idle, with full-session-history deduplication. Foreign and unowned tasks must never notify a replacement conversation; recovered tasks must not emit unsolicited terminal EventBus events. Cover failed/unconfirmed sends, busy-host deferral, pending-task retention, and detach/rebind retry.

Packaged standalone entrypoints must run with Node without development-only TypeScript loaders. Linux validation does not establish Windows process-tree cancellation or macOS pathname-socket recovery; report untested platform behavior explicitly.

## Local-only remote monitor forgetting

Fake-backend tests must cover exact-ID rejection, durable identity exclusions, preserved cached logs, zero remote calls during forget, other tasks continuing to poll, and no automatic removal after transient query errors. Deferred `get` success/failure, discovery and publication gates must not revive or notify forgotten tasks. Exclusions must survive fresh-registry restoration and SDK reload without filtering another owner/endpoint/cwd/incarnation with the same ID. Exercise old process-registry method replacement while discovery is unavailable, and fail persistence without dropping monitoring. Use fake providers only for these checks; missing remote records are not process termination evidence.

## Required gates

| Gate | Command | Required in default `npm run test`? | Status |
|---|---|---:|---|
| Typecheck | `npm run typecheck` | yes | implemented |
| Unit | `npm run test:unit` | yes | implemented |
| SDK | `npm run test:sdk` | yes | implemented |
| RPC | `npm run test:rpc` | yes | implemented |
| Component | `npm run test:component` | yes | implemented |
| Package | `npm run test:package` | yes | implemented |
| PTY/TUI | `npm run test:pty` | full gate | implemented (answers pi's Kitty keyboard-protocol negotiation; auto-skips with a loud reason on hosts that cannot deliver raw-mode Node stdin via `/usr/bin/expect`) |
| Scripted provider | `npm run test:agent-loop` | full gate | implemented |
| Pack dry run | `npm run pack:dry-run` | release gate | implemented |
| Pnpm exotic-subdependency regression | `npm run test:pnpm-pack` with pnpm 11.18.0 | Linux CI/release gate | implemented; installs the packed tarball with `blockExoticSubdeps: true` and rejects exotic production specifiers |
| Smoke | `npm run smoke` | no | implemented; isolated load-only |
| Docs verification | `npm run docs:verify` | prepack/release gate | implemented; offline docs freshness, generated region/index/manifest/link/reachability/coverage checks with advisory attestation state; optional `docs:verify:attestations` enforces fresh receipts |
| Docs tests | `npm run test:docs` | targeted docs gate | implemented; docs-gate unit/package tests |
| Payload policy | `npm run payload:check` | prepack/release gate | implemented; package payload/docs/assets exclusions and inclusions |
| Release version sanity | `npm run release:check-version` | release gate | implemented; package version/tag sanity without advertising nonexistent tags |
| Docs/gateway focused checks | frontmatter/link/version checks plus package docs gate when allowed | docs-only gate | implemented operationally; verifies `docs/**/*.md` frontmatter shape, package-local links, no standalone parent `../EXTENSION_*` links, package version wording from `package.json`, observed git tags, and documents current `docs:generate`/`docs:verify`/attestation workflow |



| Public surface | Contract |
|---|---|


## Feature coverage matrix

| Feature | Public surface | Unit | SDK | RPC | Component | PTY | Package | Scripted provider | Notes |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| Start background command from UI command | `/bg` | yes |  | yes |  | yes |  |  | Unit covers `--name` and `--agent`; RPC/PTY start real processes. |
| List tasks | `/jobs` |  |  | yes |  |  |  |  | RPC asserts running and killed task rows. |
| Show bounded logs | `/logs <id> [maxBytes]` | yes |  | yes |  |  |  |  | Unit covers bounded reads; RPC verifies output/path. |
| Kill running task | `/kill <id>` |  | yes | yes |  |  |  |  | SDK tool and RPC slash command. |
| Open task manager fallback | `/tasks`, `/bg-tasks` |  |  | discovery | yes | yes |  |  | Component covers dock; PTY covers `/tasks` and `/bg-tasks`. |
| Start background command from LLM tool | `bg_run` | yes | yes |  |  |  |  | yes | Unit derives all notification/wake modes from one typed helper. SDK exercises the registered tool's effective system prompt, descriptions, non-terminating behavior, and all four launch-receipt combinations. The scripted provider verifies a default launch yields without sleep/status/log polling before one terminal-event follow-up. |
| Attested direct Pi producer | `bg_run_pi_attested` | yes | yes |  |  |  | type/schema |  | Unit covers 128-bit ids, exact direct argv, raw events/stderr, provider/model/session capture from Pi JSON, OAuth observation via ModelRegistry, prompt/report/source hash laws, completion visibility only after durable sidecar creation, malformed-event rejection, and no sidecar for ordinary tasks. SDK runs a fake Pi CLI through the public tool and verifies one complete flat attestation. |
| Inspect task status | `bg_status` |  | yes |  |  |  |  | yes | SDK uses exact IDs for deterministic lifecycle observations and verifies the model-facing contract calls status a point-in-time inspection rather than a wait primitive. Scripted-provider ordinary waiting makes zero status calls. |
| Read task logs | `bg_logs` | yes | yes |  |  |  |  | yes | SDK verifies bounded content and the model-facing no-wait-loop contract. Scripted-provider ordinary waiting makes zero log calls. |
| Stop task from LLM tool | `bg_kill` |  | yes |  |  |  |  |  | Covers running kill and already-finished loud failure. |
| Pi/TypeBox compatibility | `peerDependencies`, packed bytes | yes |  |  |  |  | yes |  | Unit pins typebox as a `"*"` peer that is neither a runtime nor bundled dependency, requires the resolved TypeBox to be Pi 0.83/0.84's 1.3.x line, requires all four supported Pi/TUI lines in the peer range, scans all package TypeScript for the seven removed TypeBox APIs, and compiles the shipped tool schema plus nullable-array/nullable-string and optional-field shapes under TypeBox 1.3. The release compat gate repeats the removed-API scan against installed package bytes per Pi version. |
| Extension request/response service | `pi-background-tasks:request:v1` → `pi-background-tasks:response:v1` | yes | yes |  |  |  | yes |  | Unit covers closed-frame validation, capability handshake, unknown keys, unknown operation, duplicate request IDs, missing `session_start`, shutdown refusal, strict `run.payload`, strict malformed frames, and unsubscribe. SDK loads the real extension with a shared `createEventBus()`, starts `printf api-ok`, reads bounded logs, lists status, starts and kills a real sleep task, and checks malformed/unknown/duplicate controls without model/provider calls. Package tests assert `src/core/extension-api.ts` ships. |
| Terminal EventBus publication | `pi-background-tasks:terminal:v1` | yes | yes |  |  |  | yes |  | Registry unit proves one terminal snapshot after durable metadata when EventBus emit succeeds and loud/retriable delivery failure. Because retry after a listener throws may redeliver to an earlier listener, consumers must deduplicate by task id. Extension API unit proves one strict terminal frame correlated by task id after the run response for immediate, normal, failed, timeout, and killed tasks; SDK observes one terminal event for a completed task and one for a killed task through the real extension service. |
| Completion notification | custom message `background-task-notification` | yes | yes |  | renderer via typecheck |  |  | yes | BUG-181 unit/SDK coverage pins the durable-terminal guidance and truthful effective delivery receipts. Scripted provider loads the shipped extension, conditionally attempts the old `bg_status` poll when the real system prompt/descriptions/receipt are incomplete, and proves the fixed contract instead yields with exactly one `bg_run`, one terminal notification, and one default follow-up. Notification-only, notification-disabled, failed-task, and display-only `/bg` paths remain covered. |
| Footer status | `ctx.ui.setStatus` |  | load path + clear command/shortcut + mixed states/focused label |  | render semantics | yes |  |  | SDK verifies `/bg-clear` hint, failed/stopped/done combinations, running combinations, and focused label; PTY verifies Shift+Down dock path after footer-visible task. |
| Explicit agent classification | required `bg_run.isAgent`, `/bg --agent`, task metadata | yes | yes |  |  |  |  | yes | `isAgent:true` is required only for LLM/agent tasks and enables Pi-agent telemetry wrapping when the command invokes plain `pi`; `isAgent:false` is required for scripts/non-agents and prevents wrapping even if the command text looks like `pi -p ...`. |
| Per-task context usage | task row/detail + `bg_status`/metadata/notification snapshots | yes | yes |  | yes |  |  |  | SDK verifies task-owned telemetry is captured, explicitly marked background `pi` invocations are wrapped to emit telemetry, and parent `ctx.getContextUsage()` is not used; component verifies list/detail rendering plus `ctx —` placeholder. |
| Per-task token usage | background Pi-agent telemetry + `bg_status`/metadata/dock row/detail | yes | yes |  | yes |  |  |  | SDK verifies cumulative input/output/cache read/cache write/total token usage from explicit telemetry, fake `isAgent:true` wrapped child events, and real child `pi --mode json` with scripted provider; component verifies row/detail rendering. |
| Per-task tool-use counts | background Pi-agent telemetry + `bg_status`/metadata/dock row/detail | yes | yes |  | yes |  |  |  | SDK verifies total/failed/by-name tool counts from fake and real child Pi `tool_execution_start/end` events, including failed tools; component verifies row/detail rendering. |
| Per-task agent model | background Pi-agent telemetry + `bg_status`/metadata/dock row/detail | yes | yes |  | yes |  |  |  | Unit verifies `formatModelSummary`/snapshot-list rendering and telemetry ingestion of `model`; SDK verifies the model is captured from explicit telemetry, fake `isAgent:true` wrapped child `message_end` events (qualified `provider/model`), and a real child `pi --mode json` run (bare child model re-qualified from `--model`), plus that non-agent tasks report no model; component verifies compact `model <id>` row, fully-qualified `Model:` detail, and the “not reported by this background task” placeholder. |
| Agent activity transcript | wrapped Pi-agent output file + dock detail tail + `bg_logs` | yes | yes |  |  |  |  |  | Unit covers `parseAgentActivity`/`formatAgentActivityLine` for assistant text, reasoning, tool start (arrow + collapsed/truncated arg summary), and tool end (silent success, `✗ tool failed[: error]`), plus blank/invalid/non-activity narrowing. Registry unit verifies wrapped-agent stdout is reconstructed across split chunks into the transcript, `background-task-telemetry`/`-context-usage`/`-activity` control lines are stripped from the output file while still updating telemetry fields, child stderr passes through verbatim, and the trailing partial line is flushed on finalize. SDK verifies fake and real child `pi --mode json` runs render `→ tool`, `✗ tool failed`, and assistant text in `bg_logs` while keeping the telemetry/activity control JSON out of the visible output. |
| Focused dock list | overlay component |  |  |  | yes | yes |  |  | Selection/actions/history tested; PTY covers arrows, page keys, ordering with multiple tasks, failed/unread badges, and `/bg-tasks` fallback. |
| Focused dock detail | overlay component |  |  |  | yes | yes |  |  | Tail read, output box, and return-to-list tested. Component also verifies output-tail scrolling: ↑/↓ + PageUp/PageDown move through the loaded window, scrolling up pauses the live tail and shows a `lines X–Y of N` position, paging back to the bottom resumes follow, and output that fits the window never enters scroll mode. PTY drives the real arrow/page scroll keys in the detail tail. |
| Dock stop selected | `k` |  |  |  | yes |  |  |  | Component. |
| Dock stop all | `a`/`K` |  |  |  | yes | yes |  |  | Component and PTY confirmation. |
| Dock rerun | `R` |  |  |  | yes | yes |  |  | Component plus PTY running/completed/failed/killed rerun paths. |
| Dock close | `x`/`Esc`/`q` |  |  |  | yes | yes |  |  | Component + PTY. |
| Shortcut opens dock | `Shift+Down` |  | registration |  |  | yes |  |  | PTY sends xterm `ESC [ 1 ; 2 B`. |
| Clear finished notices | `/bg-clear`, optional `Ctrl+Alt+C` fallback |  | yes | yes |  |  |  |  | `/bg-clear` is the canonical terminal-independent path and is advertised while unseen finished tasks exist and the dock is closed. SDK invokes the slash-command handler and verifies fallback shortcut registration; RPC verifies `/bg-clear` clears finished notices. Opening a finished task's detail marks that task seen; merely opening the list or closing the dock does not clear other badges. |
| Update-available footer notice | `⬆ v<latest> /bg-update` footer segment + `/bg-update` command | yes | yes | yes |  |  |  |  | Unit covers semver parse/compare/precedence, `isNewerVersion`, `formatUpdateSegment`, npm/`package.json` payload narrowing, injected-fetch success/404/throw, silent internally owned timeout abort, loud independently sourced `AbortError`, and `package.json` read/degrade. SDK uses a localhost registry to verify the idle and append-to-active footer segment, `/bg-update` non-installing instructions, and that opt-out (`PI_BG_DISABLE_UPDATE_CHECK=1`), offline (`PI_OFFLINE=1`), already-current, and registry-failure paths render no segment and never throw. RPC verifies `/bg-update` discovery and offline non-installing instructions. The check is one-shot per `session_start`, time-boxed, offline-safe, and never runs on the status tick. |
| Runtime output files | `.pi/tasks/...output` | yes | yes |  |  |  |  |  | SDK asserts existence. |
| Runtime metadata files | `.pi/tasks/...json` | yes | yes |  |  |  |  |  | SDK asserts shape/status/name/context usage; registry unit tests cover metadata failure/update ordering. |
| Timeout kills task | `timeoutSeconds` |  | yes |  |  |  |  |  | SDK. |
| Output cap kills task | `PI_BG_MAX_OUTPUT_BYTES` |  |  | yes |  |  |  |  | RPC runs with a low cap and asserts failed status/log notice. |
| Reload handoff and shutdown cleanup | `session_shutdown` / `session_start` | yes | yes |  |  |  |  |  | SDK reloads the real extension runtime and asserts a running task plus completed history retain the same ids, status, logs, and kill control. Unit restores validated terminal shell history from durable metadata. Quit/session replacement still kill running tasks; registry tests cover shared stop/wait behavior. |
| Process lifecycle/races | registry core | yes | yes | yes |  | yes |  | yes | Unit tests cover POSIX process-group fallback, Windows `taskkill /T` then `/T /F` tree termination, SIGKILL escalation, duplicate finalization/notification races, notification/metadata failures, pruning, malformed telemetry, split telemetry chunks, large telemetry records above the old 16KiB buffer, and wrapped-agent transcript/telemetry separation with split-chunk and trailing-partial flush; SDK/RPC cover runtime spawn/timeout/output-cap/shutdown; scripted provider covers wakeup integration. |
| Package manifest | `package.json` |  |  |  |  |  | yes |  | Keywords, ordered `pi.extensions`, files/notices, registry-only production dependencies, local smoke/compat scripts, and direct-completion import bans. |
| Pack contents | `npm pack --dry-run`, `npm run test:pnpm-pack` |  |  |  |  |  | yes |  | Runtime files and third-party notice included; tests, fake child helpers, release-only scripts, artifacts, nested tarballs, and `node_modules` excluded. Default npm tarball install uses isolated HOME/XDG/npm cache and offline peer-ignore installation. Linux CI separately installs the tarball with pnpm 11.18.0 and `blockExoticSubdeps: true`. |
| Maintainer docs gateway | `docs/BACKGROUND-TASKS-INSTRUCTIONS.md` | docs focused |  |  |  |  |  |  | Gateway requires INDEX → read-before-edit → owning-doc navigation, records current docs generate/verify/attestation workflow, preserves subscription-only frontier routing, parent/child tool separation, durability/integrity, and no self-certification. Logo reference is package-local (`docs/assets/logo.svg`) when the asset-owner file is present. |
| Shared architecture/API/runtime/operations docs | `docs/api`, `docs/concepts`, `docs/subsystems`, `docs/reference`, `docs/operations` | docs focused |  |  |  |  |  |  | The active docs engine validates frontmatter, package-local links/reference links, INDEX reachability, exact behavioral source ownership, generated runtime contracts, deterministic generated regions, and manifest freshness. Semantic receipt state is reported by default and enforced only by the optional strict attestation command. Unsupported extraction and legacy placeholders fail closed. |
| Package maintenance version/tag wording | `docs/PUBLISHING.md`, `docs/operations/releasing.md` | docs focused |  |  |  |  |  |  | Release commands derive `VERSION` from `package.json`; observed git tags stop at `v0.6.0`, so git install/tag certification is separate from npm publishing and no nonexistent v1 tag is advertised. |

## Residual hardening coverage

Lane A residual hardening is now covered by automated tests. No remaining hardening-only gaps are intentionally left open in this plan. Future feature work should add new rows instead of weakening these gates.

| Hardened area | Coverage |
|---|---|
| Extracted process registry | `src/core/registry.ts` has direct unit coverage for state transitions and injected spawn/kill/platform behavior. |
| Agent/script classification | Unit tests cover `isAgent:true` wrapping, `isAgent:false` non-wrapping, `PI_BG_DISABLE_PI_TELEMETRY`, and non-interceptable path-qualified `pi`; SDK verifies required tool schema/runtime validation and real marked Pi telemetry. |
| Process lifecycle/races | Unit tests cover duplicate error/close finalization, output-cap races, duplicate-notification prevention, waiter resolution via stop paths, metadata failure logging, and notification failure reset. |
| Process-tree kill safety | Unit tests cover POSIX process-group kill, child fallback, both-fail loud errors, SIGTERM idempotency, SIGKILL escalation, terminal-SIGKILL semantics (a SIGKILL escalation never re-arms another timer, so a child outliving the grace window cannot produce an unbounded SIGKILL loop), single-escalation-timer behaviour for concurrent stop requests, Windows `taskkill /T` then `/T /F` ordering, duplicate graceful sharing, soft-abort-on-force, explicit force without a timer, exit-128 race recording, soft-failure escalation, loud force failure, no Windows root-only fallback, bounded helper output capture, System32 resolution with no `PATH`, and terminal metadata waiting for in-flight force. |
| Pruning | Unit tests cover oldest-finished pruning while preserving running tasks. |
| Completion follow-up turns | `test:agent-loop` registers a deterministic scripted provider against the shipped extension path and verifies event-driven `bg_run` yielding with no sleep/status/log polling, exactly one default wakeup, notification-only `triggerOnCompletion:false`, `/bg` display-only behavior, `notifyOnCompletion:false`, and failed notification error fields. |
| PTY secondary keys | `test:pty` covers arrows, page keys, `a`/`K`, `R`, `c`, `/bg-tasks`, failed/unread badges, multiple-task ordering, and rerun paths for running/completed/failed/killed tasks. |
| Footer/status combinations | SDK tests cover failed/stopped/done/running combinations, explicit clear, and focused label. |

## Acceptance checklist

- [x] `npm run test` passes offline in isolated temp dirs, including the Pi hook characterisation gate.
- [x] A guard-hook exception fails closed: it latches terminal state and suppresses content instead of letting the original message set reach the provider.
- [x] An incomplete response (`length`, non-`stop` stop reason) or a whitespace-only answer is never committed as a complete result, because a valid hash proves integrity but not completeness.
- [x] A real subscription-only run demonstrates the whole loop end to end, including that the child used both its read-only tools and the projected conversation.
- [x] `npm run test:full` validates baseline real TUI/PTY behavior.
- [x] `npm run pack:dry-run` passes.
- [x] Every listed edge case has automated coverage at the lowest reliable layer.
- [x] No real LLM/API/network dependency in default tests.
- [x] No dependency on user/global `~/.pi/agent` for SDK/RPC/PTY tests.
- [x] Volatile output is normalized in snapshot-style assertions where applicable.
- [x] Docs/gateway freshness has a focused package-local check path and documents the current package `docs:*` workflow for unconstrained runs.
- [x] Release wording derives from `package.json` version and does not advertise nonexistent git tags.
