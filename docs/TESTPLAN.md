# Verification & Test Plan

## Unit and integration
- Path sanitizer: absolute paths, `..`, URL decoding, NUL, Unicode normalization, symlink roots/children, special files and race conditions.
- Atomic saves: simulated short writes, disk full, rename failure, permission failures, process termination and revision mismatch.
- API: 401/403/409/412/413/415/428, upload name collisions, streaming limits, conditional writes, CSRF, login throttling.
- Search: Chinese sentences, English technical identifiers, punctuation/path searches, file rename/delete, rebuild and external edits.
- Editor: file switches, undo, dirty states, pending autosave, outgoing requests returning out of order, save conflict and error recovery.

## Markdown round-trip corpus
Include headings, emphasis, escaped markup, code fences, language annotations, nested task lists, tables, footnotes if claimed supported, math if enabled, frontmatter, inline HTML, HTML comments, relative image/link paths, reference-style links, unusual whitespace and Unicode. Snapshot source before/after Crepe parse/serialize; mark known normalizations. No silent data loss.

## Visual QA matrix
- Themes: light, dark, system switch.
- Viewports: 1440×900, 1024×768, 390×844.
- States: empty workspace/folder, multiple tabs, 1000+ items, long filenames, wide code block, upload progress, save error, conflict, unauthenticated.
- Interactions: mouse, keyboard, touch; focus/hover and reduced motion.

## Operational QA
- Linux amd64 and arm64 container starts and preserves both mounts across restart.
- Backup both volumes with consistent database snapshot, restore elsewhere and verify all files/index rebuild.
- Network interruption during save leaves a recoverable local draft; old or new file remains complete.
- External modification from VS Code is detected and not overwritten by a stale browser editor.

## Test priority
P0: content preservation, auth, path isolation, concurrency. P1: edit/upload/search/restore. P2: visual polish, speed and convenience. Every P0 scenario must have automated coverage before public exposure.

## Reproducible container gate

`make image && make container-test` uses isolated mounts and a persistent Chromium profile, then closes the browser, restarts the container and reopens the browser before validating a real external-file stale-write conflict and trash restore. Set `CONTAINER_ENGINE=podman` for a rootless runtime; optional `FOLIO_TEST_QEMU` explicitly marks an emulated run. It writes per-architecture evidence under `artifacts/container/`; see `M1.md` for observed results and `DEPLOY.md` for prerequisites. This gate does not replace the M3 fault/backup/security/accessibility matrix.

## M2 workflow gate

`cd frontend && npm run test:e2e -- workflow.spec.ts` exercises real Chromium mouse drags for file/folder/root moves and name collisions, keyboard browsing/rename/menu move, workspace tab shortcuts and close refusal on conflict. Invalid self/descendant/original-parent targets and forged external payloads use DOM drag-event probes with an assertion that no move request is issued; this is distinct from native pointer gesture coverage. `external.spec.ts` uses a test-only marker pointing at the isolated temporary workspace to edit/rename real files, not the development preview's workspace.

Workflow screenshots cover the real authenticated workbench at 1440×900, 1024×768 and 390×844 in both themes. The visual Markdown sample is generated in the installed serializer's format; the independent fixed-original Markdown corpus remains the authority for compatibility/fallback checks. Mobile touch, other browsers, assistive technologies, 1,000+ item measurements and backup/crash drills remain M3 work.

## M3 browser recovery slice

`cd frontend && npm run test:e2e -- recovery.spec.ts` uses real IndexedDB and an isolated server workspace. It covers latest dirty buffers across reload, explicit paused restore/manual save, missing-parent create-only recovery, same-path separate page drafts, namespace isolation, unavailable storage with working disk save/download, unknown-record export/confirmed deletion, and a separate temporary Chromium profile closed and reopened for an actual browser restart. Temporary profiles are created by the test and removed afterwards; no normal user browser profile is accessed. These tests do not stand in for the remaining mobile-touch, backup/power-loss, security/accessibility or performance gates.

## M3 mobile slice

`cd frontend && npm run test:e2e -- mobile.spec.ts` runs Chromium with a 390×844 mobile viewport and touch enabled. It verifies modal Explorer focus/backdrop/Escape, nested creation, editor-node identity after rotation, a shorter viewport's save-bar bounds, ordinary/capture file-chooser delivery, exact downloaded attachment bytes, failed upload original retention/retry and persisted source recovery. Camera files are supplied by the browser automation fixture; this does not verify a hardware camera or a real phone keyboard/IME. Existing desktop workflows remain part of `make test`.

## M3 backup slice

`make backup-test` is also included in `make test`. The isolated Go-process drill rejects active-instance backup, kills its own process after committed writes to leave WAL, checks a verified snapshot, rejects corruption/traversal/links/FIFO/existing targets, and starts the restored pair in a new directory. It verifies original password login, old-session invalidation, exact Markdown/attachment bytes, trash recovery, rebuilt search and conditional writes. `python3 scripts/backup-test.py --engine podman --container-image <image>` repeats the same contract against actual HTTPS containers with certificate validation and two bind mounts. Reports include tool hash, time and container image/architecture under `artifacts/backup/`. This does not replace the remaining crash, accessibility, security and measured performance reviews.

## M3 offline account maintenance

`cd backend && go test ./internal/auth ./internal/config ./internal/httpapi ./cmd/server` verifies offline instance-lock exclusion, new password/old password/old Cookie behavior, stable browser namespace, rollback when session revocation fails, missing-account refusal, unsafe account files/sidecars and bounded private password-file reading. The CLI integration test builds a real binary and invokes it with intentionally invalid server environment, checking that it neither starts the server nor initializes other data roots and that output contains no test password/session. These isolated tests do not replace the final container gate or a broader security audit.

## M3 security and partial-write slice

`cd backend && go test ./internal/auth ./internal/httpapi ./internal/storage` includes the explicit private-route/HEAD, every-mutation CSRF/origin and concurrent-login matrix. The Linux storage subprocess test applies RLIMIT_FSIZE only to its own child to obtain a partial write/EFBIG, and uses inotify to observe a real temporary save before SIGKILL. It verifies unchanged original content on handled write error and complete old/new content after termination. This does not fill a host filesystem, simulate real ENOSPC or prove every exact crash stage. Review evidence and remaining production-browser/fault gates are listed in `SECURITY.md`.

## M3 production-build accessibility and performance gate

`make qa` builds/embeds the real SPA and runs 4 theme/viewport accessibility flows plus a 1202-file performance flow against an isolated Go server. It covers axe WCAG A/AA scans without exclusions, real Chromium AX editor text/labels, keyboard escape/trap/return, drawer/modal handoff and tab closing without disk deletion. Performance verifies all pagination pages, Chinese/English search, a 162508-byte Markdown note, a 1060800-byte text file and exact saved contents. Measured budgets and browser/assistive-technology limitations are in `QUALITY.md`; raw reports/screenshots go to `artifacts/qa/`. Final local regression is `make test && make qa`, followed by the documented container gates.

## HTTPS security, ENOSPC and offline password container gate

`make container-review` uses only its own ephemeral HTTPS container, a 512 KiB workspace tmpfs and private app-data. Real browser probes assert actual CSP blocking, safe untrusted content/downloads, link isolation and anonymous denial. A real ENOSPC must appear in server logs; the browser retains/downloads/restores the exact draft after reload and saves after reclaiming space through trash. Outbound probe destinations are reserved `.invalid` domains intercepted/aborted by the driver. This is distinct from a mocked save failure and from persistent-volume power-loss testing.

`make container-test` now includes a third offline-password phase: the live lock rejects maintenance, then the stopped service is reset using an app-data-only container and a private secret file. After restart the old Cookie/password fail, the new password works, and workspace identity/files persist. Both container drivers pin only their temporary certificate SPKI with `ignoreHTTPSErrors: false`; the host also validates the CA/hostname. `FOLIO_TEST_QEMU` explicitly marks an emulated arm64 run. Evidence remains per image/architecture under `artifacts/security/` and `artifacts/container/`.

## Raw source line endings

`line-endings.test.ts` uses real EditorState/history transactions to verify LF/CRLF/CR, BOM, mixed separator mapping, deletion/replacement and grouped undo/redo. `line-endings.spec.ts` checks actual on-disk bytes after editing/saving/undo/redo/newlines/file switching, plus byte-exact draft downloads, page reload and explicit recovery after a mocked network save failure. HTML textarea display normalization is not used as a byte-preservation assertion. The HTTPS container write/verify/reset phases independently check a BOM/mixed-ending file through edit/undo/redo, container/browser restarts, trash restore and account reset. These are part of the final current-image gate.
