---
doc_id: operations/configuration
audience: maintainer
mode: authored
review_policy: contract
stability: stable
covers_surfaces: []
covers_sources: []
---
# Configuration

This page lists operator-facing configuration found in source. It intentionally does not invent undocumented environment variables.

## Update check

At `session_start`, the extension performs a one-shot, time-boxed npm latest-version lookup. Failures are offline-safe: the footer simply shows no update segment.

| Variable | Effect |
|---|---|
| `PI_BG_DISABLE_UPDATE_CHECK=1` | Skip the update check. |
| `PI_OFFLINE=1` | Skip the update check. |
| `PI_BG_REGISTRY_URL=<url>` | Use a registry mirror instead of `https://registry.npmjs.org`. |

`/bg-update` only prints update commands; it does not install or self-update.

## Shell selection

### POSIX

For ordinary `bg_run` and `/bg` shell commands, non-Windows platforms use `SHELL` when it is set, otherwise `/bin/sh`.

### Windows

Windows defaults to `cmd.exe`/`ComSpec`. The generic `SHELL` variable is ignored on Windows so existing `cmd` syntax does not silently change language.

| Variable | Effect |
|---|---|
| `PI_BG_SHELL=cmd` | Use Windows `cmd` dialect. |
| `PI_BG_SHELL=bash` | Use POSIX-style `bash -c` on Windows. |
| `PI_BG_SHELL_PATH=<absolute .exe/.com>` | Explicit shell path; requires `PI_BG_SHELL`. |

Invalid Windows shell settings fail loudly instead of falling back. `bash` is invoked with `-c`, not `-lc`.

## Output and log caps

| Setting/surface | Value/behavior |
|---|---|
| `PI_BG_MAX_OUTPUT_BYTES` | Optional environment override for task output cap. Default is 20 MiB. Exceeding it fails/kills the task rather than claiming success. |
| `bg_logs.maxBytes` / `/logs <id> [maxBytes]` | Bounded model-visible read. The package cap is 50 KiB. |
| Full output | Written under `.pi/tasks/<session-id>-<pid>/<task-id>.output`. |

Bounded logs are for context safety; they point to the full local output file when more bytes exist.

## Pi-agent telemetry opt-out

| Variable | Effect |
|---|---|
| `PI_BG_DISABLE_PI_TELEMETRY=1` | Do not wrap shell commands that appear to launch `pi -p ...` or `pi --mode json ...` when `isAgent:true`. Raw stdout is preserved. |

Telemetry wrapping is best-effort and task-owned. Missing telemetry is reported as unavailable, never as zero. Under Windows `cmd`, safe interception is unavailable and the command is left unchanged.

## Global Anthropic attribution and caching

Normal package installation loads the package-owned Anthropic attribution/sanitization extension before the background-task extension. Non-Anthropic sessions are unchanged. Anthropic sessions require Pi's subscription OAuth route; the provider refuses metered Anthropic credentials and reads `userID` plus `oauthAccount.accountUuid` from `~/.claude.json` without writing it.

| Variable/command | Effect |
|---|---|
| `PI_CACHE_RETENTION=long` | Default to one-hour Anthropic cache breakpoints where the model supports them. This is the package default when unset. |
| `PI_CACHE_RETENTION=short` | Default to ordinary ephemeral cache breakpoints without a one-hour TTL. |
| `PI_CACHE_RETENTION=none` | Do not add default cache breakpoints. Explicit call-level policy remains authoritative. |
| `/claude-cache status` | Show the effective cache-retention policy for the current session. |
| `/claude-cache short\|long\|default` | Store or clear a branch-local session override. |

Invalid retention values and malformed persisted overrides fail loudly. The extension also removes only the three reviewed exact-match Pi system-prompt lines rejected by Anthropic; it has no external sanitizer dependency. See [Anthropic attribution](../subsystems/anthropic-attribution.md) and [`/claude-cache`](../commands/claude-cache.md).

## Offline behavior

- Update checks skip when `PI_OFFLINE=1` and degrade to no footer update segment on any lookup failure.
- Background shell commands may still do whatever the command does; the package does not block their network access.

## Durability and platform note
