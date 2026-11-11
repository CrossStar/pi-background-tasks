---
doc_id: BACKGROUND-TASKS-INSTRUCTIONS
audience: agent
mode: authored
review_policy: contract
stability: stable
covers_surfaces: []
covers_sources: []
---
# pi-background-tasks — Mandatory Agent Gateway

**Read this before you read code, edit docs, edit code, or run anything in this package.**
This gateway is for AI agents maintaining `pi-background-tasks`. It is package-local, deterministic, and intentionally stricter than generic repo instructions.

**Logo reference:** use the package-local docs logo when present: [`docs/assets/logo.svg`](assets/logo.svg). Do not invent remote logos; asset files remain asset-owner territory and must be verified in the docs/assets payload check.

---

## Required read-before-edit order

1. [`docs/INDEX.md`](INDEX.md) — generated package navigation index. If it is absent, stale, or not generated yet, stop relying on memory and report that the docs-engine lane must create/update it.
2. [`docs/read-before-edit.md`](read-before-edit.md) — generated source-path to owning-doc read gate. If absent or stale, run/ask for the docs-engine gate before editing production sources.
3. The owning authored doc for the surface you are touching.

Current authored ownership map:

| Surface/source area | Owning doc |
|---|---|
| EventBus API; `src/core/extension-api.ts` | `docs/api/eventbus-v1.md` |
| Pi child launch resolution and durable file primitives; `src/core/pi-launch.ts`, `src/core/durable-fs.ts` | `docs/subsystems/child-launch-durability-and-safety.md` |
| Paths, artifacts, config, env, defaults, schema registry | `docs/reference/runtime-contracts.md` |
| Symptom triage | `docs/operations/troubleshooting.md` |
| QA/test operations | `docs/operations/testing.md`, then `docs/TESTING.md`, then `docs/TEST_PLAN.md` |
| Release/package maintenance | `docs/operations/releasing.md`, then `docs/PUBLISHING.md` |

---

## Hard rules

- **Code is authority for runtime facts; docs describe code.** Do not change code to satisfy prose. When code and docs disagree, update docs or file a code-owner blocker.
- **Generated regions are not hand-edited.** Regions named `<!-- pi-docs:begin ... -->` / `<!-- pi-docs:end ... -->`, `docs/INDEX.md`, `docs/read-before-edit.md`, README generated facts, and `docs/manifest.json` belong to the docs engine.
- **No silent truncation, fallback, or route substitution.** Oversized data must be persisted with hashes or rejected loudly. Unavailable model routes, missing context windows, stale config, malformed frames, missing artifacts, and unknown schemas are hard errors.
- **Frontier routing is subscription-only.** GPT/Codex and Claude-class work must use Pi subscription/OAuth channels. Never route them through metered OpenAI, Anthropic API, OpenRouter, Azure, or other paid API channels.
- **Durability and integrity are contract surfaces.** Terminal task truth is published only after output/metadata durability. Attested Pi sidecars carry hashes and schema versions; do not replace these with best-effort writes.
- **No self-certification.** If a doc freshness or attestation mechanism exists, do not stamp the same change as verified without the required independent check. If the mechanism is absent, say so plainly.

---

## Runtime roots

- Task runtime: `.pi/tasks/<session-id>-<pid>/` under the active project cwd.
- Package entrypoints, in load order: `extensions/anthropic-attribution.ts`, then `extensions/background-tasks.ts`, via `package.json.pi.extensions`.

---

## Docs generate/verify/attestation workflow

Current `package.json` exposes the docs-engine lane:

```bash
npm run docs:generate
npm run docs:verify
npm run docs:verify:attestations
npm run docs:attest/record -- <doc_id> --reviewer <identity-after-semantic-review> --verdict PASS --notes <review-notes>
```

`npm run docs:verify` treats semantic receipt freshness as advisory while preserving all deterministic docs, ownership, link, and payload checks. Use the optional `npm run docs:verify:attestations` gate when fresh independent receipts are required. `npm run docs:attest` is an alias for the recorder and still requires a reviewed doc id, reviewer, verdict, and notes; do not self-award PASS.
