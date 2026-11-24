---
doc_id: commands/bg-forget
audience: user
mode: authored
review_policy: contract
stability: evolving
covers_surfaces: [command:bg_forget]
covers_sources: []
---
# `/bg_forget`

Forget local monitoring of one persistent remote task without stopping it.

## Usage

```text
/bg_forget <exact-task-id>
```

Use the complete ID shown by `/jobs` or `/tasks`. Prefixes and multiple IDs are not accepted. The task must belong to the current Pi session and have a captured persistent external execution identity. Local tasks and legacy spawn-only remote tasks are not eligible.

Forgetting removes the selected task from the local registry, footer and task list, stops its monitoring, and stores a local exclusion record so matching remote discovery cannot restore it. Matching includes the owning session, execution endpoint, remote working directory and task incarnation, not just the visible ID. Historical logs and task metadata remain available on disk.

**Forgetting monitoring does not stop the remote task.** The command sends no remote request, does not reconnect SSH, and does not modify the remote task record or invent a terminal status. Already-submitted completion notifications cannot be retracted. An in-flight request may finish, but its result cannot revive forgotten monitoring or initiate a new completion notification.

Missing records, ENOENT, disconnections and transient query failures never automatically forget tasks. Use this command only when you deliberately want to stop monitoring that exact task.

## Errors

An unknown or partial ID, foreign owner, unsupported execution type, or failure to persist the local exclusion is reported explicitly. If persistence fails, monitoring remains in place. An admission still awaiting its first confirmed remote record cannot be forgotten, because its provisional timestamp is not a reliable task identity. For monitors retained from older extension versions, the command validates identity against existing local cached metadata; missing or mismatched metadata is reported without contacting SSH.

## Loading the feature

After updating the plugin, run `/reload` in the owning Pi session, then run the forget command there. The process registry retains tasks and captured backend APIs across reload; acquisition updates its methods, rewraps clients using their captured endpoint and working directory, and invalidates prior polling generations before rebinding the host. This lets an already-monitored unavailable task be forgotten while SSH remains disconnected. Already-started adapter work from an older extension version can finish, but stale results must not update monitoring or publish a completion. A command cannot recall notifications already submitted to Pi.

## Related commands

- [`/bg-clear`](bg-clear.md) clears finished footer badges only.
- [`/kill`](kill.md) controls task lifetime; it is not a local-monitor cleanup operation.
- [`/tasks`](task-manager.md) opens the monitor.
