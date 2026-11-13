---
doc_id: subsystems/background-task-runtime
audience: maintainer
mode: authored
review_policy: behavioral
stability: stable
covers_surfaces: []
covers_sources: [src/core/common.ts, src/core/registry.ts, src/core/windows-taskkill.ts]
---
# Background task runtime

The runtime owns task identity, shell invocation, process lifecycle, bounded logs, metadata, telemetry ingestion, completion publication, and platform termination.

## Core contracts

- Task statuses are exactly `running`, `completed`, `failed`, and `killed`.
- Terminal statuses are exactly `completed`, `failed`, and `killed`.
- Session-owned runtime directory: `.pi/tasks/<session-id>-<pid>/` under the project cwd. Durable local non-agent tasks use stable per-user service storage instead.
- Per task: `<task-id>.output` and `<task-id>.json`; some agent modes may add wrapper or attestation files.
- A process-global supervisor retains the live registry across Pi extension reload. The replacement extension runtime acquires the same registry by resolved cwd, session id, and Pi pid, then rebinds UI, notification, and EventBus delivery.
- In-memory recent retention prunes oldest finished tasks over the limit while preserving running tasks and terminal tasks with pending publication or notification.
- `resolveTask` accepts exact ids or unambiguous prefixes and fails loudly for empty, unknown, or ambiguous ids.

## Execution backends

[Execution backends v1](../api/execution-backends-v1.md) defines synchronous provider discovery and child ownership. The default remains the local shell. External providers are captured at admission, never fall back locally, and support only non-agent commands. Logs remain local. Cancellation and transport errors retain explicit unknown-outcome diagnostics instead of claiming a successful stop.

## Starting managed tasks

Managed tasks retain their existing cooperative cancellation and publication lifecycle.

## Starting ordinary tasks

`startTask` trims surrounding command whitespace and rejects an empty command. It derives task name from explicit `name`, then `description`, then command. Names are compacted and truncated; callers should still provide concise names.

For session-owned processes, shell commands are spawned in the task cwd using `stdio: ['ignore','pipe','pipe']`, `windowsHide:true`, the extension environment, and detached process groups on non-Windows. Shell commands are **not sandboxed**.

Default delivery at registry level is `notifyOnCompletion:true` and `triggerOnCompletion:false`; surface tools may override that. [`bg_run`](../tools/bg_run.md) explicitly defaults both to true.

## Shell policy

POSIX uses `$SHELL` when set, otherwise `/bin/sh`, with `-c <command>`.

Windows defaults to `cmd.exe` or `ComSpec`, with args `['/d','/s','/c','"<command>"']` and `windowsVerbatimArguments:true`. `PI_BG_SHELL=cmd|bash` can select a shell; `PI_BG_SHELL_PATH` is accepted only with `PI_BG_SHELL` and must be an absolute `.exe`/`.com` path. `PI_BG_SHELL=bash` without a path searches PATH for `bash.exe` or `bash.com`; unresolved or invalid shell settings fail before creating a task.

## Logs and output caps

All child stdout/stderr is written to the output file unless it is recognized control telemetry from a wrapped Pi agent. The runtime enforces `PI_BG_MAX_OUTPUT_BYTES` or the default 20 MiB output cap; exceeding it appends an error notice, kills the task, and finalizes as `failed`.

Model-visible log reads use bounded file reads capped by `MAX_LOG_BYTES` (currently up to 50 KiB). Persistent-task failure diagnostics are included in the log response separately from the supervisor-owned log file. Truncated reads preserve the full output path in the notice.

## Telemetry

Telemetry is task-owned. Durable non-agent commands preserve raw output and do not interpret telemetry control records; telemetry parsing belongs to session-owned agent execution. It is parsed from task output/control lines when the task reports it; it is never copied from the parent session. Optional telemetry includes context usage, token usage, tool usage, and model. Malformed optional telemetry is ignored without clearing prior task state; unknown wrapped-agent JSON is written to the transcript rather than silently dropped.

`isAgent` explicitly controls telemetry wrapping. If `isAgent:false`, a `pi -p` command is treated as an ordinary command. If `isAgent:true` and the POSIX command contains an interceptable `pi -p`, `pi --print`, or `pi --mode json` invocation, the runtime writes a wrapper and converts Pi JSON events into task-owned metrics and human transcript lines. Path-qualified `pi` commands are not intercepted. On Windows cmd, telemetry wrapping is unavailable and the task records `win32-cmd-cannot-safely-intercept-pi-argv`.

## Finalization and completion

A child closing with code `0` becomes `completed` unless killed/timeout/cap state overrides it. Nonzero exit becomes `failed` with `Exited with code ...`. User or shutdown kills become `killed`; timeout and output cap become `failed`.

During finalization, the runtime flushes wrapped-agent output, ends and waits for the output stream to finish/close, writes terminal metadata through the durable metadata path, updates waiters, initiates terminal EventBus publication, sends the completion notification when enabled and not shutting down, persists notification state, then prunes old finished tasks. Actual EventBus emission may wait behind the run-response publication gate and therefore may occur after the completion notification; it still occurs only after stream close and terminal metadata. The registry calls a historically named `closeAndFsyncOutputStream()` helper, but its current implementation ends and observes the stream rather than issuing `fsync` for ordinary `.output`; durable terminal truth refers to the metadata-backed status, not a stronger crash-durability guarantee for every output byte.

Terminal delivery is eligible only after terminal metadata has been persisted and the publication gate has resolved. Rebinding cannot bypass either condition. If both terminal metadata writes fail, the task records the failure locally and logs it without sending a durable completion receipt. Actual EventBus emission checks that a host is still bound, including after an asynchronous gate wait.

## Reload handoff

On `session_shutdown` with reason `reload`, the host detaches stale Pi callbacks without setting shutdown state or stopping tasks. Live child handles, timers, managed cancellation hooks, output streams, and task identity remain in the process-global registry. The replacement runtime acquires that registry during `session_start`, installs a fresh EventBus service, and rebinds callbacks before normal use. A task that reaches terminal state during the short detached interval keeps notification and terminal publication pending; rebinding retries those deliveries rather than marking them sent to a stale runtime.

Production local non-agent commands use the per-user daemon and a detached per-task supervisor. Their logs and records live in stable service storage, discovered by project cwd and ownerSession on session start. The supervisor owns output, timeout, cancellation, and terminal metadata; the registry never opens their output stream or rewrites their metadata. Polling is bounded and uses unreferenced timers. Shutdown detaches polling and leaves these commands running. Cancellation waits for a verified terminal record; unknown outcomes remain `failed` with a diagnostic.

Persistent external execution providers use the same durable polling and owner-session restoration semantics. Agents, attested runs, managed workflows, and legacy spawn-only external execution providers retain session-owned process semantics. Injecting `spawn` into registry options disables durable delegation for deterministic tests. Hot reload retains the live registry and delivery eligibility. Fresh same-owner session/process restoration preserves notification preferences and catches up unacknowledged completions after the host becomes idle. Terminal EventBus publication remains suppressed for recovered tasks. The host checks actual session-history receipts before setting notified; unconfirmed deliveries remain retained and retry with bounded backoff. This does not promise exactly-once delivery across concurrent hosts or stronger durability than the host session store.

Polling refresh failures leave tasks running because availability is unknown. Each task retries after 2, 4, 8, 16, then at most 30 seconds; changing diagnostics does not restart this backoff. The one-second polling scheduler skips tasks before their retry deadline without consuming one of its four concurrent refresh slots, preserving round-robin progress for healthy tasks. A consecutive unchanged failure logs once as a bounded single-line message without an Error stack; a changed message may log again. Successful record application clears retry state and replaces the transient diagnostic with the record's diagnostic. Explicit operations and reconnect restoration do not wait for polling backoff. Refresh results from before host detach or shutdown are ignored, including failures, so stale requests cannot update UI or log into a replacement session.

## Stopping tasks

Only `running` tasks can be stopped. Managed tasks invoke their task-owned cancellation callback and wait for workflow settlement; process tasks use the platform paths below.

POSIX stop path:

1. send `SIGTERM` to the detached process group (`-pid`),
2. if that fails, call the child handle's `kill`,
3. after the grace window, send one `SIGKILL` escalation.

Windows stop path:

1. run `%SystemRoot%\System32\taskkill.exe /PID <pid> /T`, or `%WINDIR%` fallback,
2. after the grace window, abort the soft helper and run `/F`,
3. treat taskkill exit 128 as an already-exited race,
4. surface force failures loudly with `Descendant processes may have leaked`.

Windows never falls back to root-only `child.kill` for tree termination. The taskkill helper uses structured argv, `shell:false`, bounded stdout/stderr capture, external abort, and a helper timeout.

## Related docs

- [`bg_run`](../tools/bg_run.md)
- [`bg_status`](../tools/bg_status.md)
- [`bg_logs`](../tools/bg_logs.md)
- [`bg_kill`](../tools/bg_kill.md)
- [Completion delivery](../concepts/completion-delivery.md)
- [Host UI and telemetry](host-ui-and-telemetry.md)

## Source ownership/reference

Primary source ownership for this document is `src/core/common.ts`, `src/core/registry.ts`, and `src/core/windows-taskkill.ts`.
