# Architecture — Web Markdown Workspace

## 1. Deployment model
A Vite-built React SPA is embedded into a Go binary using `embed`. Go serves both the frontend and `/api/v1`. One container, two mounts:
- `/workspace`: user content; the sole authority for file bytes.
- `/app-data`: SQLite index/settings/auth, trash and optional draft recovery metadata.

Caddy/Traefik terminates HTTPS in typical deployments; the Go server listens internally. No cloud dependencies, no background job platform, no Serverless runtime.

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
