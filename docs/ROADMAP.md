# Delivery Roadmap & Definition of Done

Implementation order is dependency-driven, not a fixed schedule. Each milestone must leave the repository in a runnable, tested state. Avoid broad one-shot agent code generation.

## M0 — Feasibility gate
- Bootstrap Vite React TS and Go API skeleton.
- Mount Crepe, load Markdown, serialize and inspect round-trip fixtures.
- Mount CodeMirror; switch across tabs without editor lifecycle leaks.
- Establish theme tokens, shell skeleton, light/dark snapshots.
- Define unsafe/lossy Markdown fallback to source mode.
**Exit gate:** M0 fixture suite passes or all incompatibilities are documented with safe fallback; an editor can be torn down/remounted without losing prior session data.

M0 implementation and verification notes: [`M0.md`](M0.md). This remains an in-memory editor spike; it does not claim M1 persistence or auth.

## M1 — Daily-usable single-user build
- Session auth; Explorer; file CRUD; Editor Registry.
- Upload/download, Markdown images, previews; tabs.
- Conditional save and conflict dialog; file safety guard; basic trash.
- Single Docker image and two mounts.
**Exit gate:** end-to-end demo from SPEC acceptance; path security and stale-write tests pass.

M1 exit gate passed on 2026-10-15: native amd64 and QEMU-user arm64 HTTPS container acceptance. Evidence and explicit runtime limits are recorded in [`M1.md`](M1.md), deployment instructions in [`DEPLOY.md`](DEPLOY.md). M3 security/recovery/performance QA remains outstanding.

## M2 — Workflow polish
- Search (Chinese and English fixtures), quick-open.
- Keyboard shortcuts; rename/move; external-change reconciliation.
- Better empty/loading/error states; refine dark/light and file tree.
**Exit gate:** search and external-edit tests pass; UI reviewed against DESIGN.md.

M2 exit gate passed: Chinese/English search, quick-open, external-change reconciliation, drag/drop moves and keyboard workflow are implemented and verified. The real workbench was reviewed in both themes at all three design viewports. Evidence and remaining M3 limits are recorded in [`M2.md`](M2.md).

## M3 — Recovery & mobile
- Mobile drawer/responsive editors; upload from phone.
- Draft recovery, restore tests, backup documentation.
- Security and accessibility reviews; measured performance regression suite.
**Exit gate:** mobile flows, recoverability and deploy/recovery drill verified.

M3 is in progress: browser recovery, mobile Explorer/uploads, offline dual-volume backup/restore, offline account recovery and initial security/fault checks are implemented. Production-build accessibility and measured performance checks are recorded in [`QUALITY.md`](QUALITY.md). Final browser-security, ENOSPC and dual-architecture deployment gates remain; the overall M3 gate is not yet passed. Evidence and limits are in [`M3.md`](M3.md).

## Change control
When introducing a feature, update SPEC/API/DESIGN (as applicable), list failure modes, implement test coverage, and record any deliberately unsupported behavior. Do not silently expand scope or switch frameworks.
