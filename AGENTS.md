# Repository instructions for AI contributors

## Current scope

This is HTML Artifact Editor, a local-first visual text correction tool for existing HTML. HAE-001/002 add the toolchain and read-only project previews; HAE-003 verifies static mapping and native text selection; HAE-004 adds a pure byte-patch candidate engine. Product UI, live draft editing and file saving are not implemented. Read README.md, PRD.md, ARCHITECTURE.md, docs/PATCH_SPEC.md and the target Issue before implementation.

Human-readable project documentation is primarily Simplified Chinese. Keep identifiers and API contracts concise in English. Do not copy private conversations, user paths or unrelated project data into this public repository.

## Invariants

- Preserve the original file bytes outside verified text patch ranges. Never save a serialized whole DOM/AST as a shortcut.
- Never locate a write using only a selector, global text replace, or page-supplied offsets/paths.
- Reject unsupported/ambiguous source mappings. The MVP guarantees only supported static text; JavaScript interaction preview is read-only.
- Core modules must be pure and OS-independent. OS-specific code belongs to platform/storage adapters.
- Keep trusted editor UI separate from untrusted Preview. No Node integration, broad IPC bridge, arbitrary file access or shell access in user content.
- Keep offline policy, sandbox, context isolation, web security, CSP and IPC validation intact.
- Apply/cancel changes affect drafts; only explicit Save writes the HTML. Failure or unknown outcome must preserve drafts and source/recovery evidence.
- Do not bypass backup, conflict detection or recovery to make a demo appear complete.
- Never add layout editing, structural DOM edits, framework source editing, AI services or network features without an explicit scope change.

## Frontend model assignment

- User requirement: frontend design and implementation must use the latest officially released Kimi model available for the task. The verified baseline on 2026-09-08 is Kimi K3 via Kimi Code, using the full CLI alias `kimi-code/k3`.
- This applies to product UI components, styling, interaction states, accessibility and frontend portions of mixed tasks. Keep React/TypeScript as the application stack; Kimi is a development tool, not an application runtime dependency.
- Before each frontend task, check official model information and the configured/available Kimi Code models. Record the verification date, CLI version, actual alias/model and relevant settings; keep that choice stable within the task. Do not silently substitute an older model or another provider when the selected model is unavailable.
- Kimi owns the bounded frontend change. The primary development agent owns core/source mapping, file transactions, security, integration and independent review. Mixed tasks must define the frontend files and contracts before handing off; do not grant the UI authority to change protected core boundaries.
- Retain one writer at a time unless parallel work is explicitly arranged. Actual Kimi execution must be recorded before claiming that Kimi produced a frontend change; this planning amendment does not itself run a frontend implementation task.
- Follow the detailed model selection and handoff policy in docs/AI_WORKFLOW.md.

## Working process

1. Inspect current worktree, target Issue, dependencies and existing code. Preserve unrelated and parallel changes.
2. Work on one bounded task at a time. Default to one writer; do not launch parallel agents unless explicitly arranged by the user.
3. State the concrete behavior to deliver, implement a small slice, then run checks appropriate to its risk.
4. UI work must follow docs/PRODUCT_DESIGN.md, including IME, focus, drafts, cancel, async revisions, errors and responsive limits. Obtain a selected visual target before implementing the product UI.
5. Verify a runnable result and inspect the diff. Mark manual or unavailable-platform checks as pending, never passed.
6. Update relevant specs when contracts change. Summarize behavior, evidence, limitations and next task.

## Available checks today

User requirement: do not use GitHub Actions or GitHub-hosted CI. Run build, test, smoke and documentation checks locally; use real target machines for platform acceptance. Do not add workflow files or require remote CI checks for merge/release. Repository Actions are disabled. `npm ci` below installs locked dependencies locally and remains part of setup.

```sh
npm ci
npm run check
python tools/check_docs.py
git diff --check
```

Use the Node/npm versions in docs/DEVELOPMENT.md and Python 3.10+ for documentation checks. Electron test:smoke/security/mapping/patch cover the experiments in docs/implementation/HAE-001.md through HAE-004.md. These do not substitute for native-dialog, file-transaction, platform or product acceptance. Avoid adding tests that merely mirror low-impact documentation edits.

For core/file changes, required evidence includes byte preservation, entity/Unicode handling, rejected ambiguous targets, save conflict, failure and recovery tests. For UI changes, also provide executed interaction evidence; screenshots alone do not prove functionality.

## Publishing and privacy

The initial public MIT repository creation was explicitly requested. Later publication must follow the authorization for that task; this file does not grant ongoing permission to publish any arbitrary changes, artifacts or user data.

Fetch current refs, check branch/worktree state, stage only intended paths, inspect staged diff, run applicable gates, and verify remote/local commit parity after an authorized push. Do not force-push, disable certificate validation, or use broad staging to sweep unrelated work.

Never commit secrets, user documents, private snapshots, backups, recovery logs, signing certificates or generated installers. Keep LICENSE notices and third-party license obligations intact.

## Task source

docs/backlog.json defines the planning baseline; docs/BACKLOG.md is its readable rendering with Issue links. GitHub Issues track execution status. If changing task definitions, update JSON, regenerate the Markdown with tools/render_backlog.py and synchronize affected Issue descriptions deliberately.
