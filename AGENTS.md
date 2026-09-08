# Repository instructions for AI contributors

## Current scope

This is HTML Artifact Editor, a local-first visual text correction tool for existing HTML. The repository currently contains planning documents and documentation checks, not an implemented desktop application. Read README.md, PRD.md, ARCHITECTURE.md, docs/PATCH_SPEC.md and the target Issue before implementation.

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

## Working process

1. Inspect current worktree, target Issue, dependencies and existing code. Preserve unrelated and parallel changes.
2. Work on one bounded task at a time. Default to one writer; do not launch parallel agents unless explicitly arranged by the user.
3. State the concrete behavior to deliver, implement a small slice, then run checks appropriate to its risk.
4. UI work must follow docs/PRODUCT_DESIGN.md, including IME, focus, drafts, cancel, async revisions, errors and responsive limits. Obtain a selected visual target before implementing the product UI.
5. Verify a runnable result and inspect the diff. Mark manual or unavailable-platform checks as pending, never passed.
6. Update relevant specs when contracts change. Summarize behavior, evidence, limitations and next task.

## Available checks today

```sh
python tools/check_docs.py
git diff --check
```

Python 3.10+ is sufficient. HAE-001 will introduce real application build/test commands and dependency lock files. Do not invent or report nonexistent npm/electron checks. Avoid adding tests that merely mirror low-impact documentation edits.

For core/file changes, required evidence includes byte preservation, entity/Unicode handling, rejected ambiguous targets, save conflict, failure and recovery tests. For UI changes, also provide executed interaction evidence; screenshots alone do not prove functionality.

## Publishing and privacy

The initial public MIT repository creation was explicitly requested. Later publication must follow the authorization for that task; this file does not grant ongoing permission to publish any arbitrary changes, artifacts or user data.

Fetch current refs, check branch/worktree state, stage only intended paths, inspect staged diff, run applicable gates, and verify remote/local commit parity after an authorized push. Do not force-push, disable certificate validation, or use broad staging to sweep unrelated work.

Never commit secrets, user documents, private snapshots, backups, recovery logs, signing certificates or generated installers. Keep LICENSE notices and third-party license obligations intact.

## Task source

docs/backlog.json defines the planning baseline; docs/BACKLOG.md is its readable rendering with Issue links. GitHub Issues track execution status. If changing task definitions, update JSON, regenerate the Markdown with tools/render_backlog.py and synchronize affected Issue descriptions deliberately.
