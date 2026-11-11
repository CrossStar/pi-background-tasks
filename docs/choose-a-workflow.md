---
doc_id: choose-a-workflow
audience: user
mode: authored
review_policy: contract
stability: stable
covers_surfaces: []
covers_sources: []
---
# Choose a workflow

## Quick decision tree

1. **Is the work short and interactive?** Use ordinary foreground Pi work.
2. **Is it a long shell command?** Use `/bg` if you are typing it; use `bg_run` if the agent is launching it.
3. **Do you need local evidence from one direct Pi child run?** Use `bg_run_pi_attested`.

## Comparison table

| Option | Sync/async | Context sent | Can read repo? | Can use network? | Can write? | Route behavior | Use when |
|---|---|---|---:|---:|---:|---|---|
| Foreground work | Synchronous | Current session | Depends on active tools | Depends on active tools | Depends on active tools | Current session route | You need live interaction. |
| `/bg` | Async | None by package | Command decides | Command decides | Command decides | Not a model route unless command invokes one | You manually start a long local command. |
| `bg_run` | Async | None by package | Command decides | Command decides | Command decides | Not a model route unless command invokes one | Pi should launch a long command and resume later. |
| `bg_run_pi_attested` | Async | Prompt only | Child Pi decides from prompt/tools | Child Pi route/tools decide | Report path requested | Structured provider/model; OAuth observed for supported subscription routes | Local evidence-producing Pi run. |

## Tradeoffs and boundaries

### Foreground vs background shell

Foreground commands are best when the next answer depends on immediate output. Background commands are best when the command may take long enough that Pi can do other useful work or yield until completion.

`/bg` and `bg_run` are not sandboxes. They spawn local shell commands with the permissions, environment, network access, and credentials available to the Pi process. A background command can itself call paid services.

### `bg_run` defaults

`bg_run` requires:

```json
{"name":"Short label","command":"shell command","isAgent":false}
```

Defaults are `notifyOnCompletion:true` and `triggerOnCompletion:true`. With those defaults, Pi should not poll `bg_status` or `bg_logs` merely to wait.


See [attested Pi runs](tools/bg_run_pi_attested.md) for structured child execution with durable evidence.
