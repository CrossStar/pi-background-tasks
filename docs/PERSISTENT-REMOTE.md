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

Providers optionally expose `persistent` start/get/list/cancel/logs methods alongside the legacy spawn method. The registry captures provider identity, cwd, and bound methods synchronously before admission. A persistent admission error never selects the legacy spawn or local runner. Ambiguous starts retain their original ID and are queried rather than resubmitted.

Remote output paths are opaque. Log data is canonical base64; offsets and lengths count bytes. The registry downloads chunks of at most 49,152 bytes into `.pi/tasks/remote/<sha256(JSON.stringify([provider.id,cwd,ownerSession]))>/<id>.output`. Existing file length is the resume offset. Terminal publication waits until `min(outputBytes, output cap)` bytes are cached. Interrupted or malformed responses leave the task monitored with a diagnostic.

On session start and `sydney-kit:bg-persistent-ready:v1`, fresh synchronous discovery supplies a provider for listing its cwd. Newly discovered tasks preserve their original notification preferences and catch up unacknowledged completions only in their owning session; terminal EventBus events are not replayed. Existing tasks retain their captured clients. Task IDs colliding across endpoints, directories, or local tasks are rejected. Shutdown detaches monitoring without cancellation.

## Explicit local forgetting

[`/bg_forget`](commands/bg-forget.md) removes local monitoring only. It uses the client identity captured at admission, even while SSH is disconnected or another route is selected. It never calls persistent start/get/list/cancel/logs, changes remote files, or declares the task completed. Cached logs are preserved. Durable local exclusions match full task identity and are consulted during remote discovery; a missing remote record or transient query error is not an exclusion.

The mutable `sydney-kit:bg-hook:v1` request still receives `available:true`. Setting `includePersistentRuntime:true` additionally returns `runtimeBundle:{protocol:1,sha256,files}` or an explicit `error`. Files are UTF-8 strings for exactly daemon.mjs, shared.mjs, supervisor.mjs, windows-tree.mjs, and remote-bridge.mjs. Assets are lazily read relative to this package, cached only after successful loading, and contain no authentication files or environment. The digest is SHA256 over UTF-8 `JSON.stringify(Object.fromEntries(Object.entries(files).sort(([a],[b])=>a.localeCompare(b))))`.
