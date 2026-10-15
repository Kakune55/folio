# Agent Instructions — Web Markdown Workspace

Read `docs/SPEC.md`, `docs/DESIGN.md`, `docs/ARCHITECTURE.md`, `docs/API.md`, `docs/ROADMAP.md` and `docs/TESTPLAN.md` before significant implementation.

## Non-negotiable
1. React + TS + Vite; Milkdown Crepe; CodeMirror 6; Go; embedded SQLite. Do not replace stack without explicit decision.
2. Real files are canonical; SQLite must never become the authority for note content. No block IDs or proprietary Markdown syntax.
3. Never silently lose or overwrite content: ETag conditional writes, dirty state, recovery and unsafe Markdown serialization detection.
4. Security-first file operations: workspace root containment, symlink/TOCTOU safety, upload limits, safe previews, authenticated endpoints.
5. Follow DESIGN.md: minimal not bare, strong typography, subdued chrome, coherent light/dark modes. No elaborate dashboards or gratuitous cards.
6. Build one vertical slice per milestone; supply tests and document limitations. Do not claim a feature complete until tested.
7. Separate editor document buffers from global React/Zustand state. Do not reconstruct Crepe on keystrokes.
8. No Serverless rewrite, multi-service infrastructure, Next.js, or speculative S3 integration.
9. When implementing, consult current installed package types/docs; do not assume APIs from old tutorials.
10. Prefer explicit failures and recovery UI over silent fallback. Fix root cause rather than hiding errors.

## Expected agent output per task
- Change summary with files affected.
- Verification commands and observed results.
- Data-loss/security concerns and unsupported cases.
- Follow-up strictly within roadmap scope.

## Suggested first task
Implement M0 only: create React/Go skeleton, theme tokens and minimal workbench shell, mount Milkdown Crepe with source serialization fixture tests, mount CodeMirror, demonstrate switching among two files without stale content or listener leaks. No database/search yet.
