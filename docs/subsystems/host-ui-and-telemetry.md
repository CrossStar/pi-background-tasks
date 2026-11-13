---
doc_id: subsystems/host-ui-and-telemetry
audience: maintainer
mode: authored
review_policy: behavioral
stability: stable
covers_surfaces: []
covers_sources: [extensions/background-tasks.ts, src/core/update-check.ts, src/extension.ts, src/ui/background-tasks-manager.ts, src/ui/log-search.ts]
---
# Host UI and telemetry

This subsystem owns the extension entrypoint, command/tool registration, footer dock, task manager UI, completion renderer, and update-available footer notice. Task lifecycle internals are owned by [background-task-runtime](background-task-runtime.md).

## Entrypoint and registration

`extensions/background-tasks.ts` re-exports `src/extension.ts`. The extension registers:

- commands: `/bg`, `/tasks`, `/bg-tasks`, `/bg-clear`, `/bg-update`, `/jobs`, `/logs`, `/kill`;
- tools: `bg_run`, `bg_status`, `bg_logs`, `bg_kill` plus package-owned advanced tools documented elsewhere;
- shortcuts: `shift+down` and `ctrl+alt+c`;
- renderer: `background-task-notification`.

## Execution discovery

Connection-ready restoration failures are reported as bounded message strings, not Error objects with stacks. Identical failures are suppressed until a successful restoration; callbacks from an obsolete hook generation or session context cannot report into the replacement session.

The host emits `sydney-kit:bg-execution:v1` synchronously for each task admission and exposes the compatible `sydney-kit:bg-hook:v1` readiness probe. Discovery errors and conflicting providers fail closed. Readiness listeners are detached on shutdown and rebound on session start; registry handoff receives the new host resolver, while admitted tasks keep their original backend. External task reruns from the dock are rejected to prevent executing an old remote command against a new target. See [execution backends v1](../api/execution-backends-v1.md).

## Footer status

The footer widget is updated on task changes and once per second while a session is active. The background-task entry remains visible: if there are no running tasks and no unseen finished tasks, it displays `bg idle · Shift↓` (or `focused` while the dock is open). An available update segment is appended. Footer text, manager titles and selected rows use the theme accent foreground without a background fill.

When visible, the footer label includes counts in this order:

1. running,
2. failed,
3. stopped (`killed`),
4. done (`completed`),
5. entry hint (`focused` while the dock is open, otherwise `Shift↓`),
6. `/bg-clear` hint when there are unseen finished tasks **and the dock is closed**,
7. optional update segment.

A finished badge is cleared when that task's detail view is opened, or when `/bg-clear` or its shortcut marks all currently unseen finished tasks as seen. Merely opening the list view or closing the dock does not clear badges.

## Task manager UI

`/tasks`, `/bg-tasks`, and `Shift+Down` open the same overlay. Non-interactive contexts receive an error notification directing users to `/jobs`, `/logs`, `bg_status`, or `bg_logs`.


On Pi hosts that dispatch normalized mouse events (fullscreen TUI), `handleMouse` scrolls only when a wheel event is inside the rendered log body. Both wide/narrow previews and detail output use the same scrolling/follow behavior as the keyboard. Hit regions are rebuilt on render and clipped to the visible body, so headers, the task list, command viewer and clipped rows do not consume wheel events. The extension does not enable terminal mouse reporting itself; older Pi versions and normal terminal scrollback modes retain keyboard controls.

Detail output semantics:

- reads a UI-only tail buffer of 128 KiB;
- refreshes every second while following; paused views retain their buffer and count newly observed newline bytes in bounded 64 KiB increments (a `+` suffix means more bytes remain to scan);
- shows up to 12 output lines, adapting to the overlay height;
- scrolling up pauses follow and freezes the buffer;
- reaching the bottom or pressing `r` or `f` resumes follow;
- normalizes CRLF newlines and displays the latest carriage-return (`\r`) frame on each line, so single-line progress bars such as tqdm refresh instead of concatenating old frames; a trailing CR retains the visible frame until replacement text arrives;
- this is a log viewer, not a full terminal emulator: multi-row cursor movement is not interpreted;
- missing output files and read failures are displayed in the detail box.

`v` opens a full-command view from either the list or detail. It wraps the complete command to terminal width, preserves explicit line breaks, and pages within the available height. Arrows and PgUp/PgDn scroll, Home/End jump, `y` copies the unchanged command, and Esc returns to the previous view without closing the monitor.

`/` opens a literal, case-sensitive search input. Enter searches the full file using bounded 64 KiB reads against the size observed when search starts. Queries are limited to 4096 UTF-8 bytes. A match displays a bounded 16 KiB excerpt beginning at the matched byte, with the byte offset shown; `n` and `N` find subsequent/previous matches without wrapping. Searching does not load the whole file into memory. Switching tasks, following again, or closing cancels pending search and prevents stale results replacing another task's output. `y` copies the command, `p` copies the absolute output path, and `o` opens the complete log in the host's default application. Failures remain visible inside the monitor.

## Completion rendering

`background-task-notification` renders `[bg completed]`, `[bg failed]`, `[bg killed]`, or other status with task name, id, output path, and error. The notification content itself is produced by the runtime and may trigger a follow-up turn depending on task flags.

## Update check

The update check is one-shot per extension runtime, launched after `session_start` without blocking session startup. It is skipped for `PI_BG_DISABLE_UPDATE_CHECK=1`, `PI_OFFLINE=1`, or missing installed version. The npm registry URL defaults to `https://registry.npmjs.org` and can be overridden by `PI_BG_REGISTRY_URL`. Fetch is time-boxed by `DEFAULT_UPDATE_TIMEOUT_MS` (2000 ms) and every network/status/payload failure resolves to no update segment.

When a newer semver is found, the footer segment is `⬆ v<latest> /bg-update`. `/bg-update` prints npm/git install instructions only; it never installs or self-updates.

## Telemetry display


## Reload and shutdown


On quit or session replacement (`new`, `resume`, `fork`), the extension stops session-owned tasks, detaches durable local non-agent tasks, clears polling and the status interval, releases the process registry, and closes the event service. Session start restores durable project tasks from the service without unsolicited model wake or terminal EventBus replay. Offline completions remain visible as unread tasks. Reload preserves the same registry and its existing delivery eligibility.

## Related docs

- [Shortcuts and dock](../reference/shortcuts-and-dock.md)
- [`/tasks` and `/bg-tasks`](../commands/task-manager.md)
- [`/bg-clear`](../commands/bg-clear.md)
- [`/bg-update`](../commands/bg-update.md)
- [Completion delivery](../concepts/completion-delivery.md)
- [Background task runtime](background-task-runtime.md)

## Source ownership/reference

Primary source ownership for this document is `extensions/background-tasks.ts`, `src/extension.ts`, `src/core/update-check.ts`, and `src/ui/background-tasks-manager.ts`.
