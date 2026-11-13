---
doc_id: session-ownership
audience: maintainer
mode: authored
review_policy: contract
stability: evolving
covers_surfaces: []
covers_sources: []
---
# Persistent task ownership

Persistent local and SSH tasks belong to the stable Pi session ID recorded as `ownerSession`. Resuming that same ID, including in a different Node process, discovers its tasks in the selected project and remote route. A new or forked session has a different ID and cannot discover, resolve, read logs for, or cancel the original session's tasks. Session transitions do not cancel persistent tasks.

Ownership is captured before asynchronous admission and remains fixed for the registry and its task clients. Callers without a session ID receive a registry-private random identity; they do not share an empty or process-wide owner. A registry rejects attempts to bind a different identity. The extension selects a fresh registry on identity changes; same-session reload can retain its existing registry and active tasks.

Old records without an owner remain on disk but are not automatically claimed or imported. This release adds no cross-session claiming interface.

Ownership metadata is distinct from a notification subscription. Disk recovery restores status, logs, and cancellation for the matching owner in monitoring-only mode. It does not replay terminal notifications or wake the model unexpectedly. Same-session in-process reload retains existing notification behavior. Session-owned agents and managed workflows retain their normal shutdown and cleanup behavior.
