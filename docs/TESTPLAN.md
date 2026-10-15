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
