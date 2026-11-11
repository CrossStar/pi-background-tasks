---
doc_id: operations/troubleshooting
audience: maintainer
mode: authored
review_policy: contract
stability: evolving
covers_surfaces: []
covers_sources: []
---
# Troubleshooting

Start from the symptom, verify the source-owned doc, then apply the remediation. Do not tier-bump models, switch routes, or add fallbacks to make a failure disappear.

| Symptom/error | Likely cause | Remediation |
|---|---|---|
| EventBus response says `request frame must be an object`, `unknown key`, `schema_version mismatch`, or duplicate `request_id` | Request frame violates the closed EventBus v1 schema | Fix caller frame to match `docs/api/eventbus-v1.md`; never relax closed-frame validation. |
| EventBus says service unavailable before `session_start` | Extension API is installed but no session context exists | Start/await Pi session startup; do not fabricate a context. |
| Terminal event arrives unexpectedly early in a consumer | Consumer is not waiting for the `run` response before correlating task id, or an older implementation lacks the gate | Bind response first; current API gates terminal publication for `run`/`kill`. See `docs/api/eventbus-v1.md`. |
| `bg_run` starts but logs are bounded/truncated | `bg_logs` is model-visible and capped by design | Read the full output file path from the notice only when operator-approved; do not increase model-visible logs casually. |
| A task id disappears after `/reload` | The replacement runtime failed to acquire the process-supervised registry, or terminal metadata was malformed/outside the active runtime directory | Inspect stderr for `cannot restore task metadata`, verify cwd/session/Pi pid continuity, and run the SDK reload-handoff regression. Do not adopt a `running` metadata record by PID alone. |
| Output cap terminates a task | `PI_BG_MAX_OUTPUT_BYTES` cap reached | Inspect full command behavior; raise cap only deliberately for that run environment. The task failure is intentional safety. |
| `PI_BG_SHELL` or `PI_BG_SHELL_PATH` error on Windows | Windows shell selection is closed and path-validated | Use `PI_BG_SHELL=cmd` or `bash`; if setting `PI_BG_SHELL_PATH`, provide an absolute `.exe`/`.com`. See `docs/subsystems/child-launch-durability-and-safety.md`. |
| `pi_executable_resolution_failed` | Windows Pi package bin cannot be resolved/validated | Reinstall/repair Pi package; do not fall back to shell PATH shims. |
| `pi_command_line_too_long` | Rendered Windows command line exceeds 32,767 UTF-16 units | Move large payload to stdin/artifact path; do not truncate argv. |
| Terminal metadata/output durability failure | Fsync/close/metadata write failed | Treat terminal state as failed; inspect `DurableFileError` operation/path/cause. See `docs/subsystems/child-launch-durability-and-safety.md`. |
| `child_runtime_limit_exceeded` | The child exceeded 550 provider requests or 600 tool calls | Inspect the failed audit seal and split an unbounded task; do not raise limits blindly. |
| `child_cache_policy_invalid` | Claude cache policy, retention configuration, or final cache-control shape was invalid | Set `PI_CACHE_RETENTION` to `none`, `short`, or `long`; do not bypass its four-breakpoint or shape checks. |
| `/bg-update` shows no update | Offline/opt-out/current-version/registry failure path | Check `PI_OFFLINE`, `PI_BG_DISABLE_UPDATE_CHECK`, `PI_BG_REGISTRY_URL`; update check is one-shot and non-blocking. |
| TypeBox/compat failure | Installed package resolved a private/nested TypeBox or used removed APIs | Keep TypeBox as Pi-provided peer and verify installed payload. See `docs/operations/releasing.md`. |
