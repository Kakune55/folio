# Web Markdown Workspace

**Design and implementation blueprint (not yet an application).**

A lightweight, self-hosted browser-first Markdown and developer-file workspace. React/Vite + Milkdown Crepe + CodeMirror 6 frontend, Go monolith, local filesystem authoritative storage, optional SQLite FTS5 search index, one Docker container.

## Documentation
- [`docs/SPEC.md`](docs/SPEC.md): product specification, scope and acceptance.
- [`docs/DESIGN.md`](docs/DESIGN.md): polished, minimal visual system and interactions.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): application boundaries and data flow.
- [`docs/API.md`](docs/API.md): proposed REST API and revision contract.
- [`docs/ROADMAP.md`](docs/ROADMAP.md): incremental delivery stages.
- [`docs/TESTPLAN.md`](docs/TESTPLAN.md): reliability, security and UX verification.
- [`AGENTS.md`](AGENTS.md): AI coding guardrails and suggested first task.

## Start building
Open the repository in your coding agent and ask it to implement **M0 only** following `AGENTS.md` and `docs/ROADMAP.md`. Review its Markdown round-trip tests and editing-session lifecycle before authorizing M1.

## Note
This package contains requirements and design documents only. No functional service, Dockerfile or generated application code is included yet; these are implementation deliverables.
