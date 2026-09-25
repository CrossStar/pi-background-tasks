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

## Footer status

The footer widget is updated on task changes and once per second while a session is active. If there are no running tasks and no unseen finished tasks, the background-task footer is cleared unless an update segment is available.

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

The monitor lists tasks alongside a live output preview at widths of 100 columns or more, and stacks the preview below the list on narrower terminals. Selection is retained by task id across status-driven reordering. `1` selects running tasks, `2` all tasks, and `3` failed tasks. A preview alone does not mark a task seen. Selected-task metadata includes runtime, exit code, PID when available, output size, and the output file modification age; unavailable modification times are labeled explicitly. The list view supports selection, paging, stop, confirmed stop-all, history toggle, rerun, output path, and close. Rerun is shell-task-only: typed delegate and Fusion tasks fail with guidance to relaunch through their owning tool rather than executing their display command as a shell command. The detail view shows task identity, status, runtime, output path, description, task-owned model/context/tokens/tools when reported, command, error, and an output tail.

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

The UI keeps lists and log previews focused on command execution: name, status, runtime, PID, exit/error, output size and modification age. Output age uses seconds as its smallest unit (`0s` for less than one second). Ordinary shell tasks never show model/context/token/tool telemetry or unavailable-data placeholders. Details for tasks explicitly marked as agents, Delegate tasks and Fusion tasks show only telemetry actually reported by that task. The UI never copies telemetry from the parent session into a task. Raw command output is preserved, including any model text printed by the command.

## Reload and shutdown

On reload, the extension clears its session-scoped UI timer, detaches stale host callbacks, and closes the old EventBus service without stopping tasks. The replacement runtime acquires the process-supervised registry, restores terminal shell history when no live task object exists, installs a fresh EventBus service, and rebinds UI/notification/terminal callbacks. Running shell, Delegate, attested Pi, managed Fusion, and other registry-owned tasks therefore remain addressable by the same id across hot reload.

On quit or session replacement (`new`, `resume`, `fork`), the extension marks the registry as shutting down, clears the status interval, kills running tasks with reason `Killed during Pi session shutdown`, reports cleanup failures through the UI when possible, releases the process-supervised registry, and closes the event service.

## Related docs

- [Shortcuts and dock](../reference/shortcuts-and-dock.md)
- [`/tasks` and `/bg-tasks`](../commands/task-manager.md)
- [`/bg-clear`](../commands/bg-clear.md)
- [`/bg-update`](../commands/bg-update.md)
- [Completion delivery](../concepts/completion-delivery.md)
- [Background task runtime](background-task-runtime.md)

## Source ownership/reference

Primary source ownership for this document is `extensions/background-tasks.ts`, `src/extension.ts`, `src/core/update-check.ts`, and `src/ui/background-tasks-manager.ts`.
