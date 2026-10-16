# Architecture — Web Markdown Workspace

## 1. Deployment model
A Vite-built React SPA is embedded into a Go binary using `embed`. Go serves both the frontend and `/api/v1`. One container, two mounts:
- `/workspace`: user content; the sole authority for file bytes.
- `/app-data`: SQLite index/settings/auth, trash and optional draft recovery metadata.

An existing Caddy/Traefik can terminate HTTPS with Go listening internally; alternatively Go serves TLS directly from a configured certificate/key pair. No additional proxy service is bundled. No cloud dependencies, no background job platform, no Serverless runtime.

## 2. Frontend modules
- `app/`: routing, global providers, shell and error boundaries.
- `features/explorer`: folders, tree, context actions, uploads and DnD.
- `features/tabs`: open-file selection and dirty-state displays.
- `features/search`: quick-open and FTS results.
- `features/auth`: session boundary.
- `editors/milkdown`: Crepe lifecycle, markdown/source conversion, upload bridge.
- `editors/codemirror`: generic text/config editor, language registry.
- `viewers`: image/PDF/binary.
- `services/api`: typed HTTP client with abort, revisions and error handling.
- `stores`: Zustand transient workspace UI state only.

Use TanStack Query for fetched tree, metadata, search and mutation invalidations. Live editor buffers must remain inside the editor/session controller to prevent React render churn. No re-creation of Crepe on every keystroke. Bind editing sessions by stable canonical path plus revision; on rename, update both file identity and active session routing.

## 3. Backend modules
- `internal/httpapi`: authentication, decoding, validation, standardized errors, responses.
- `internal/auth`: password/session lifecycle; secure cookies and CSRF checks.
- `internal/workspace`: canonical workspace operations and metadata.
- `internal/storage`: safe descriptor-oriented file operations, atomic saves and revision check.
- `internal/search`: indexer, FTS5 and reconciliation.
- `internal/trash`: deletions, listing and restoring with provenance.
- `internal/config`: mount paths, limits, server settings.

Prefer `net/http` and Go standard library; add libraries only where they clearly simplify security or maintenance. SQLite is a cache/index and application metadata store; never authority for file bytes.

## 4. File identity and write invariants
The core external identifier is a normalized workspace-relative path. Internal operation locks should key by canonical safely resolved location. Rename/move atomicity differs by filesystem; handle cross-device move explicitly rather than falsely claiming atomic move. Detect stale revisions on every write and fail closed; serialize in-process writes. Multi-instance writers against the same workspace are not supported in V1; document this in deployment.

Filesystem watcher is an optimization: periodically reconcile to detect external changes; edits from VS Code or Syncthing can occur. Never auto-overwrite a dirty browser buffer when external changes are found.

## 5. Markdown serialization boundary
Source file -> parse by Crepe -> edit -> serialize -> save. Unsupported constructs or lossy round trips must be handled by source mode or explicit user consent. Never treat the rendered DOM as authoritative Markdown. Images use standard relative links, not application-only asset IDs.

## 6. Repository layout
```
frontend/
  src/app/
  src/components/ui/
  src/features/{explorer,tabs,search,auth}/
  src/editors/{milkdown,codemirror}/
  src/viewers/
  src/services/
  src/stores/
  src/styles/
backend/
  cmd/server/
  internal/{httpapi,auth,workspace,storage,search,trash,config}/
  web/dist/               # copied by Docker build for go:embed
  go.mod
 docs/
  SPEC.md
  DESIGN.md
  ARCHITECTURE.md
  API.md
  ROADMAP.md
  TESTPLAN.md
AGENTS.md
Dockerfile
compose.yaml
```

## 7. Non-goals and future migrations
Storage adapters, S3, collaboration, PWA/offline sync and a full workspace plugin system are deferred. Do not introduce speculative interfaces or microservices. Keep editor/viewer dispatch extensible without exposing arbitrary third-party executable plugins.

## 8. Trash operations implemented in M1

`internal/storage` owns descriptor-safe move, subtree revisions and staged cross-device copying. `internal/trash` owns private recovery directories and atomic JSON manifests under app-data. Payloads remain ordinary files, outside SQLite. Same-device moves use rename; cross-device deletion stages the original in its parent, durably copies to app-data, and only then removes the staged copy. Cross-device restoration publishes a verified, synced temporary payload with no-replace rename. Failed cleanup or divergent recovery copies are preserved for explicit recovery rather than silently discarded.

## 9. Search cache implemented in M2

`internal/search` uses a private `search.db` separate from authentication `app.db`, so a corrupt search cache does not prevent login or editing. FTS5 trigram indexes safe workspace-relative file paths and eligible UTF-8 text bodies. One- and two-character queries use a bounded-result substring scan; longer queries are quoted literal FTS phrases. SQLite remains secondary; no document is restored from this cache.

Successful file mutations enqueue a coalesced asynchronous scan. External changes are reconciled every 10 seconds using device/inode/size/mtime/ctime; a full content scan every 5 minutes covers coarse timestamp behavior. Scans do not hold the storage write mutex. A transaction retains the previous cache if a scan fails, with an explicit warning. Manual rebuild quarantines a damaged search cache and its WAL/SHM before reconstructing it from workspace files; it never touches auth data. Open editor buffers are reconciled independently by the session controller as described below.

## 10. Open session reconciliation

A frontend session probe checks bounded text revisions every 10 seconds while visible and on focus/visibility restoration, separately from search indexing. Probes capture session identity, path, revision and generation; late responses after an in-app save, move, close or remount are ignored. They never replace source or advance the base revision. Clean buffers offer explicit reload; dirty buffers enter conflict and stop autosave. Reload checks again after reading so typing during the request wins. Missing paths preserve drafts and allow a user-chosen create-only copy path. External rename is not inferred from filenames or hashes. Attachment probes compare metadata rather than hashing unbounded binary files.

## 11. Explorer workflow

The frontend uses native desktop drag events with a page-local random gesture token; it never parses arbitrary external drop data into workspace paths. Folder/root targets route into the same conditional move controller as the keyboard-accessible move dialog. The controller flushes affected buffers, checks revisions, locks old/new path prefixes and remaps sessions only after success. Browser-owned tab shortcuts remain untouched; the workspace provides alternate close/switch chords and visible help. These controls never replace server authentication, root containment or no-overwrite checks.

## 12. Browser recovery cache

A dedicated session buffer listener feeds a serial IndexedDB writer, independent of the React UI subscription. Each live editing session has a random record ID so different pages cannot replace each other's same-path draft. Transactions store ordinary text plus the original base revision; acknowledged saves delete only their own record. Recovery is an explicit copy into a fresh, paused source session or a create-only file, followed by conditional deletion of the old record. Cache failures preserve the queue and warn; unknown records are never automatically purged.

The authenticated bootstrap adds an opaque root/account-bound `workspaceId`. The page pins it for requests, including a query equivalent on file URLs. A changed service root is rejected rather than allowing an old page to write to a new mount. The identity is a recovery namespace, not an authorization token or filesystem CAS. App-data/volume migration can change it; browser cache is device/origin-local and separate from server backup.

## 13. Responsive shell and upload originals

A media-query subscription switches only Explorer presentation between desktop aside and a Radix modal drawer. The document editor remains outside that branch; its upload/navigation bridge stays stable across a viewport resize. A cleaned-up VisualViewport subscription exposes visible height/offset as CSS variables on small screens, retaining browser zoom behavior.

File-picker/camera uploads use a separate in-memory queue retaining the raw File until a server acknowledgment. It survives auth-boundary component unmounts, supports explicit retry/download/confirmed discard and participates in logout/beforeunload protection. This queue is neither persistent draft storage nor server authority; it cannot survive page destruction. Server content/type/size/no-overwrite validation remains unchanged.
