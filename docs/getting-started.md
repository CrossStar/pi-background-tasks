---
doc_id: getting-started
audience: user
mode: authored
review_policy: contract
stability: stable
covers_surfaces: []
covers_sources: []
---
# Getting started

This guide gets from install to useful background work in a few minutes.

## 1. Install

```bash
pi install npm:pi-background-tasks@latest
```

For a project-local install:

```bash
pi install npm:pi-background-tasks@latest -l
```

For current repository state rather than a release tag:

```bash
pi install git:github.com/ismailsaleekh/pi-background-tasks@main
```

For a local checkout/package path:

```bash
pi install .
pi install . -l
```

## 2. Start your first `/bg` task

Inside a project, run:

```text
/bg --name "Docs server" npm run docs:dev
```

`/bg` starts a tracked shell command, returns a task id, and writes output under `.pi/tasks/...`. The command is still an ordinary local shell command; the package tracks it but does not sandbox it.

## 3. Observe completion

Use the footer dock or commands:

```text
/jobs
/logs <task id> 20000
```

Press **Shift↓** to open the dock when the `bg ...` footer appears. `/bg-clear` acknowledges finished-task footer notices.

## 4. Start an agent-launched background task

When Pi itself should start a long command, use the `bg_run` tool with the strict schema:

```json
{
  "name": "Typecheck",
  "command": "npm run typecheck",
  "isAgent": false
}
```

`bg_run` defaults `notifyOnCompletion:true` and `triggerOnCompletion:true`, so Pi should not sleep or poll merely to wait. The terminal notification is the wake-up path.

Set `isAgent:true` only when the shell command launches a child Pi/LLM agent, such as `pi -p ...` or `pi --mode json ...`.

## Next links

- [Choose a workflow](choose-a-workflow.md)
- [Configuration](operations/configuration.md)
- [README landing page](../README.md)
