---
doc_id: PERSISTENT-REMOTE
audience: maintainer
mode: authored
review_policy: behavioral
stability: stable
covers_surfaces: []
covers_sources: [src/core/persistent-runtime.ts, src/core/remote-persistent.ts]
---
# Persistent remote execution

## Protocol 2 upgrade

The new local namespace is `~/.pi/background-tasks-v2`; the remote namespace is `~/.pi/background-tasks-remote-v2`. Old local and remote durable tasks keep running, but are not discovered by the new service. There is no migration, cross-instance restoration, or daemon replacement. Do not point `PI_BG_SERVICE_DIR` at an old service root. Runtime assets are installed by digest; first use starts only the new service.

Providers optionally expose `persistent` start/get/list/cancel/logs methods alongside the legacy spawn method. The registry captures provider identity, cwd, and bound methods synchronously before admission. A persistent admission error never selects the legacy spawn or local runner. Ambiguous starts retain their original ID and are queried rather than resubmitted.

Remote output paths are opaque. Log data is canonical base64; offsets and lengths count bytes. The registry downloads chunks of at most 49,152 bytes into `.pi/tasks/remote/<sha256(JSON.stringify([provider.id,cwd,ownerSession]))>/<id>.output`. Existing file length is the resume offset. Terminal publication waits until `min(outputBytes, output cap)` bytes are cached. Interrupted or malformed responses leave the task monitored with a diagnostic.

On session start and `sydney-kit:bg-persistent-ready:v1`, fresh synchronous discovery supplies a provider for listing its cwd. Newly discovered tasks preserve their original notification preferences and catch up unacknowledged completions only in their owning session; terminal EventBus events are not replayed. Existing tasks retain their captured clients. Task IDs colliding across endpoints, directories, or local tasks are rejected. Shutdown detaches monitoring without cancellation.

## Mirror transport and memory

Protocol 2 adds `mirrorLogs(id, offset, maxBytes, ownerSession?, source?)`, a source-ID-only operation capped at 512 KiB. It uses the same ownership and cursor validation as `logs`; ordinary/model-facing reads retain their 49,152-byte RPC cap. A 4 MiB window needs eight data transfers rather than 86. Providers without the optional method use their ordinary bounded range API. In-memory source windows are released at terminal state, forget and host detach; release generations prevent in-flight synchronization from repopulating released buffers. Disk mirrors remain available.

Both packages must be installed together: sydney-kit accepts only protocol-2 bundles. Old local and remote service tasks keep running, but are invisible and receive no completion notifications through the new extension.

## Explicit local forgetting

[`/bg_forget`](commands/bg-forget.md) removes local monitoring only. It uses the client identity captured at admission, even while SSH is disconnected or another route is selected. It never calls persistent start/get/list/cancel/logs, changes remote files, or declares the task completed. Cached logs are preserved. Durable local exclusions match full task identity and are consulted during remote discovery; a missing remote record or transient query error is not an exclusion.

The mutable `sydney-kit:bg-hook:v1` request still receives `available:true`. Setting `includePersistentRuntime:true` additionally returns `runtimeBundle:{protocol:2,sha256,files}` or an explicit `error`. Files are UTF-8 strings for exactly daemon.mjs, shared.mjs, supervisor.mjs, windows-tree.mjs, remote-bridge.mjs, log-sources.mjs, and slurm-watch.mjs. Assets are lazily read relative to this package, cached only after successful loading, and contain no authentication files or environment. The digest is SHA256 over UTF-8 `JSON.stringify(Object.fromEntries(Object.entries(files).sort(([a],[b])=>a.localeCompare(b))))`.
