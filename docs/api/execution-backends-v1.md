---
doc_id: api/execution-backends-v1
audience: maintainer
mode: authored
review_policy: behavioral
stability: evolving
covers_surfaces: []
covers_sources: [src/core/execution-backend.ts]
---
# Execution backends v1

The extension discovers an execution provider synchronously when admitting a command. No provider means the existing local shell backend. A provider or discovery error is authoritative: failures never retry through a local shell. The transport adapter owns process creation, output, exit detection, cancellation verification and its connections. The background registry owns local log files, status, output caps, timeout policy and completion delivery.

## Persistent remote execution

A provider may additionally expose `persistent: { start, get, list, cancel, logs }`. The registry captures these methods and the provider's nonempty `id` and absolute remote `cwd` synchronously. Persistent methods replace child spawning for non-agent tasks; errors never fall back to `spawn` or local execution. `start` accepts a caller-generated task ID, command, remote cwd, name, timeout and output cap. Retries and recovery retain that ID. `get` and `cancel` return task records; `list(cwd)` returns records with admission diagnostics. `logs(id, offset, maxBytes)` returns base64 bytes, `nextOffset`, `size` and `eof`, with requests capped at 49,152 bytes.

For this capability, the remote supervisor owns timeout, output limits, cancellation and durable terminal records. Pi synchronizes bounded logs into a local cache and persists its terminal view before delivery. A transport interruption preserves the last known state with diagnostics; it does not prove failure or termination. Shutdown detaches persistent tasks. Recovered tasks preserve their original notification preferences and can deliver outstanding completions only to the same owner session, with session-history deduplication. They never wake another conversation. Legacy child-based behavior described below remains unchanged.

The readiness hook accepts `includePersistentRuntime:true` and returns `runtimeBundle:{protocol:1,sha256,files}` or an explicit `error`. The digest is SHA256 of UTF-8 canonical JSON with filename keys sorted via `localeCompare`. Bundle files are `daemon.mjs`, `shared.mjs`, `supervisor.mjs`, `windows-tree.mjs`, and `remote-bridge.mjs`. Sydney installs them into an immutable private directory on the remote Linux host. Runtime bundle errors must fail discovery, not silently downgrade to session-bound execution.

After connecting, reconnecting or changing cwd, the adapter emits `sydney-kit:bg-persistent-ready:v1`. The extension discovers the current provider again and restores tasks for that route and cwd. Previously admitted tasks retain their captured controls. Authentication material is not part of the bundle or task metadata. See [persistent runtime](../subsystems/persistent-runtime.md) for service and bridge behavior.

## Discovery and compatibility

The event names intentionally retain Sydney's existing protocol:

- `sydney-kit:bg-execution:v1`: mutable `{ provider?, error? }` request. A listener must set a provider or error before returning, without asynchronous discovery.
- `sydney-kit:bg-hook:v1`: mutable readiness probe. The native extension sets `available: true` while loaded. No installation patch is necessary.

The exported types and constants live in `src/core/execution-backend.ts`. A provider has this shape:

```ts
interface BackgroundExecutionProvider {
  readonly id?: string;
  readonly cwd?: string;
  spawn(command: string, isAgent: boolean): BackgroundTaskChildProcess;
}
```

At discovery, the provider must capture an immutable route, authentication factory and execution cwd. Its `spawn` closure must use that captured target rather than the current foreground SSH connection. Optional `id` is a credential-free backend identifier; optional `cwd` describes the same captured directory. These fields are descriptive, not instructions for the registry to change a remote directory. Legacy providers exposing only `spawn` remain supported; their remote cwd is owned by the closure and cannot be inferred from the local workspace.

A listener seeing an existing provider must set `request.error` rather than replacing it. The native extension also rejects conflicting provider assignments. If SSH routing is active but unavailable, report an error; returning no provider would explicitly select local execution.

The registry captures the selected backend before asynchronous task setup. Switching or disconnecting the foreground route affects subsequent admissions only. Task output and metadata stay in the local runtime directory; execution metadata is separate from those local paths. Remote tasks cannot be rerun from the dock because a new route selection could silently change their execution target.

## Child interface and ownership

`spawn(command, false)` returns synchronously with a child-shaped event source. It may connect asynchronously, but must defer output and lifecycle events until listeners can attach. Supply `stdout` and `stderr` data sources, `on('error', ...)`, `on('close', ...)` and `kill(signal?)`. Do not expose a remote PID as a local process identifier. The registry never applies local process-group or Windows process-tree termination to an external child.

An optional `dispose()` hook releases child-owned resources. It must be idempotent, release the entire task-owned SSH route (including jump hosts), abort pending acquisition when possible, and release resources acquired after disposal. It must prevent any future command launch. Disposal is cleanup, not proof that a previously launched remote process stopped. Legacy children without this hook must perform their own cleanup on every terminal path; native integration cannot repair a transport adapter that leaks pending connections.

Emit `close(code, signal)` only when the remote outcome is known. Successful cancellation must mean either launch was prevented or termination was verified. A transport failure, missing exit status, failed process identity check, or unverifiable cancellation must emit `error`. Do not reconnect or replay the command. Finish stdout/stderr delivery before close. Avoid emitting both terminal events; the registry still protects finalization against duplicates.

Only non-agent shell tasks are supported by external backends. Remote `isAgent:true` and attested Pi execution are rejected before spawning, including direct registry/EventBus paths. Ordinary local agent execution remains available when no external provider is selected.

## Stop and unknown outcome

The four task statuses remain `running`, `completed`, `failed`, and `killed`. Unknown remote outcome is a **failed** task with explicit unknown-outcome diagnostics, never a successful stop. A pending user cancellation or timeout cannot override transport uncertainty. Timeout remains failure even when termination is verified. The registry bounds waiting for cancellation; expiry cannot prove process death. Kill callers must receive an error when termination was not confirmed.

A backend must latch cancellation even while connecting. Check it before acquisition, after every awaited connection step, and immediately before command launch. Once launch may have occurred, cancellation needs transport-specific identity and process-group verification. Closing a network connection alone is insufficient.

## Sydney migration

The reviewed integration is `integrations/background/{README.md,manifest.json,install.mjs}`, `vendor/pi-ssh-remote/index.ts` and `src/ssh/background.ts` in sydney-kit. Native support replaces source patching; do not update the old version/hash allowlist to force installation. Keep any legacy installer restricted to old releases, and update the missing-hook diagnostic to recommend loading a native-compatible background extension.

The existing synchronous provider discovery and `spawn(command, false)` work unchanged. For complete lifecycle guarantees, Sydney should:

1. Add credential-free `id` and captured `cwd` to the provider returned from the already cloned route snapshot.
2. Implement idempotent child `dispose()` and cancellation-aware route acquisition. Release jump clients and late-arriving connections; never release the foreground connection.
3. Prevent launch when cancellation happens before connection completes. The current child only sets `stopping` and later launches before stopping; this must be fixed inside the adapter.
4. Start cancellation deadlines at the request, including connection setup and waiting for process identity. Guard late continuations after terminal failure/disposal.
5. Preserve unknown-outcome errors. A missing `/proc/<pgid>/stat` does not prove that descendants in the group have exited: verify group absence, otherwise report uncertainty without blindly killing a reused identity.
6. Release connections in terminal cleanup even if an event listener throws. Never reconnect or replay a command after transport failure.

Adapter tests should cover cancellation before connection with zero command launches, late acquisition after disposal, jump-authentication cancellation, changed foreground routes, missing leader with surviving descendants, and cancellation verification failure. Registry tests exercise fake backends deterministically; they do not certify a real SSH server or the adapter's process-group implementation.
