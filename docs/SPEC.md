# Web Markdown Workspace — Product & Technical Specification

Status: V1.0 baseline · 2026-10-15

## 1. Vision and boundaries
A self-hosted, browser-first Markdown notebook and developer file workspace. **Files are the product**: Markdown, JSON, INI, YAML, logs, images, PDFs, archives and other resources coexist in an ordinary directory. The application adds a polished interface, not a proprietary content format.

Principles: File First; Markdown First (not Markdown Only); Web First; Simple by Default; Portable; Single-user First; Secure by Default. No block IDs, knowledge graph, proprietary note databases or required desktop app.

### Users and jobs
- Open any browser, authenticate and immediately edit notes.
- Store config snippets, logs, screenshots, schematics, PDFs and archives next to the corresponding note.
- Locate files by directory, quick-open or full-text search.
- Back up, edit or inspect the same directory using standard tools outside the app.

### Success criteria
- Complete ordinary daily Markdown editing, text/config editing, file upload/download, search and file organization in a browser.
- No silent loss or overwrite of user content on failed saves, concurrent edits or unsupported Markdown serialization.
- Portable data: workspace remains useful without this application.
- Runs as one Docker image on Linux amd64/arm64, with two persistent mounts and no external database.

## 2. Stack (DECIDED)
| Concern | Decision |
|---|---|
| Frontend | React + TypeScript + Vite, SPA (no Next.js/SSR) |
| Components | shadcn/ui (source-owned components) + Radix primitives where appropriate |
| Styling | Tailwind CSS + CSS design tokens; Lucide React icons |
| Routing | React Router |
| Remote state | TanStack Query |
| UI state | Zustand; never put every editor keystroke into global state |
| Markdown | Milkdown Crepe, dynamically loaded |
| Text/code | CodeMirror 6, dynamically loaded |
| File tree DnD | dnd-kit if necessary; keyboard-accessible alternatives required |
| Backend | Go modular monolith, net/http + explicit middleware |
| Index | Embedded SQLite FTS5; secondary, rebuildable |
| Source of truth | Local filesystem |
| Deployment | Go embeds Vite dist; Docker image; mounted `/workspace` and `/app-data` |

Versions are pinned in lockfiles; verify dependency APIs against the versions installed. Prefer stable versions, never invent package APIs.

## 3. Information architecture
Desktop: compact top bar (workspace, search, settings), left Explorer (resizable, collapsible), tab strip, main editor/preview, optional small status bar. The document remains the visual focus. **No mandatory right panel**, complex splits, dashboards or graph canvas in V1.

Mobile: full-width document view, drawer Explorer, accessible file switcher, touch-friendly menus, uploads/camera photos. No installation or PWA requirement.

### Explorer
Tree folder expansion; create, rename, move, delete to trash, upload, download; context menu; keyboard navigation; file extension icons. Search by name and contents. Keep empty states actionable. No mandatory attachment folder.

### Editors and viewers
- `.md`, `.markdown`: Milkdown Crepe WYSIWYG, with CodeMirror raw-source alternative.
- `.txt`, `.log`, `.json`, `.jsonc`, `.yaml`, `.yml`, `.ini`, `.toml`, `.go`, `.py`, `.sh`, `.js`, `.ts` and recognized UTF-8 text: CodeMirror 6 with language support where available.
- PNG/JPEG/WebP/GIF: image viewer; SVG treated as untrusted active content and only rendered with strict isolation or shown as source/download.
- PDF: browser-based safe preview with download.
- ZIP/7z/unknown/binary: metadata and download (no server-side extraction or execution).
- Unknown type never opened blindly as HTML in the app origin.

Use an editor/viewer registry that maps file metadata to a component. Editor components own active document model; workspace state owns only tabs, navigation, file revisions and dirty status. Preserve drafts on navigation. Only one editable instance per file per browser workspace in V1.

### Markdown compatibility
Standard relative links and image paths (e.g. `![Image](./screenshot.png)`), preserved as ordinary Markdown. Internal file references open in app tabs. External links use safe browser navigation. No need for Wiki Links in V1.

Milkdown may normalize or discard unsupported Markdown constructs. Establish a round-trip fixture suite (frontmatter, HTML, tables, fenced languages, nested lists, math, escapes, reference links, comments). Compare input -> parse -> serialize; reject unsafe conversion without a warning and a path back to raw source. **Never silently save lossy content.** Rich/source mode transitions must respect dirty state and undo-history limitations.

## 4. Functional scope
### M0: editor spike
React + Milkdown Crepe mounting/lifecycle; raw Markdown extraction, realistic round-trip fixtures; CodeMirror; editing different files without cross-file state corruption. Decide safe behavior for unsupported syntax and switching modes.

### M1: useful personal app
Single-user login; Explorer CRUD; multi-tabs; Milkdown/CodeMirror; autosave, explicit save and conflict handling; paste/drop image, upload attachments; download/preview basics; one-container deploy.

### M2: usability
Name quick-open; full-text search; keyboard shortcuts; move/rename DnD; trash restore; external changes detection; stable file previews.

### M3: resilience/mobile
Responsive layout; browser draft recovery; backup/restore documentation and tests; security, accessibility and performance QA.

### Excluded from V1
Block database, graph, mandatory tags, bidirectional links, custom plugin marketplace, collaboration/CRDT, filesystem shell, server command execution, Git UI, AI authoring, Obsidian plugin emulation, offline sync, S3 and WebDAV backends, public anonymous sharing.

## 5. Persistence model
Filesystem paths relative to a configured `/workspace` root. Preserve Unicode names. Store no authoritative file contents in SQLite. `/app-data` holds `app.db` (auth/settings metadata), a separate rebuildable `search.db` cache, trash and recovery data. External filesystem editors are allowed, so watch + reconcile changes; do not rely exclusively on inotify (network mounts may differ). Ignore app data, dangerous device files and unsafe symlinks.

### Safe files API
Reject absolute paths, traversal, NUL, unsupported special files and symlink escape. Normalize paths carefully; path-prefix string checks alone are insufficient. Use descriptor-relative safe open primitives where available (e.g. Go platform-specific openat2 beneath/no-symlinks) or a conservative no-symlink file policy with race-safe traversal. Deny out-of-root operations and test races.

### Consistency
- `GET` returns content plus opaque revision/ETag.
- Writes supply `If-Match` (or explicit base revision); mismatches return HTTP 409/412 consistently per API contract. No last-write-wins.
- Server serializes writes per canonical path; externally modified files are detected by validating current revision immediately before replacement.
- Same-directory temporary write, flush, atomic rename and directory sync where supported; avoid partial writes. Preserve reasonable permissions.
- Autosave: ~800ms after last edit; visible Saving/Saved/Unsaved/Error/Conflict state. `Ctrl/Cmd+S` forces save. Failed requests retain dirty buffer. Browser draft cache keyed by workspace and canonical path is optional for M3 but worth early prototyping.
- Deletion moves to app-managed trash with safe restore; file revisions and backup are distinct concerns. Define a documented backup procedure for both mounts, including SQLite consistency.

## 6. Search
FTS5 index filenames, paths and Markdown/eligible text bodies under a configurable size cap; no OCR or PDF text in V1. Use tokenizer strategy suitable for Chinese and English (test trigram vs tokenization for actual search behavior). Results show filename, path, excerpt. Index is rebuilt on demand; filesystem is authority; index errors never prevent editing.

## 7. Auth and security
Single local account for V1. Strong password hashing (Argon2id preferred), HttpOnly Secure SameSite cookie-based sessions, session rotation, logout/revocation, CSRF defense for mutations, rate-limited login, HTTPS behind a trusted reverse proxy or directly using configured Go TLS certificates, restrictive CORS and headers. Do not expose unrestricted filesystem browsing or executable endpoints. Untrusted uploads and previews served safely (prefer attachment disposition or isolated origin for active content). Authenticate all file and preview endpoints. Security review prior to public exposure.

Default configurable maxima: editable text 5 MiB, images 20 MiB, PDF 50 MiB, arbitrary attachments 100 MiB; enforce limits while streaming and prevent decompression bombs by not auto-extracting. Identical names never silently overwrite.

## 8. Shortcuts
`Ctrl/Cmd+S` save; `Ctrl/Cmd+P` quick open; `Ctrl/Cmd+Shift+F` global search; `Ctrl/Cmd+W` close tab where browser interception permits; `Ctrl/Cmd+Tab` switch tabs where permitted; `Ctrl/Cmd+B` toggle Explorer. Do not override editor formatting or browser-critical shortcuts without fallback controls.

## 9. Quality and acceptance tests
- Round-trip Markdown corpus, with documented unsupported cases.
- Concurrent write with stale ETag must reject and preserve both versions (recoverable local draft).
- Server crash mid-save must leave a complete old or new file, never truncated content.
- Path traversal, symlink traversal, filename edge-cases, upload limits, HTML/SVG injection, CSRF/session tests.
- External file rename/change reflected or reconciled with explicit conflict handling.
- Mobile viewport, keyboard Explorer, dialogs and screen reader labels.
- Verify actual loading of a large note, 1,000+ tree items and multi-file search; set measured performance targets after M0 rather than inventing them.

## 10. Acceptance definition
M1 is accepted only when a user can create a folder, write a Markdown note, paste an image, edit a JSON alongside it, switch tabs, safely autosave, close/reopen the browser, download files, and recover from a stale-write conflict in a deployed container.
