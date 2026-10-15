# HTTP API Contract — Draft V1

Base path `/api/v1`, JSON except streaming file upload/download. All routes require a valid session except login and optional health. Same-origin cookies; anti-CSRF token/header on mutation requests. Each API version has stable errors and request schema. This document is a **contract proposal**; implement and test before declaring stable.

## Conventions
- Paths are workspace-relative URL query strings or JSON strings; encode URI components properly. Example `Linux/PVE/notes.md`. Never accept server absolute paths.
- Filename/text metadata UTF-8. Binary content streams raw bytes, not JSON base64.
- `revision` is opaque (e.g. strong hash/ETag) and returned for content reads; writes must supply `If-Match: "<revision>"`. Use `If-None-Match: *` for create-only writes.
- File timestamps are advisory; must not be the only concurrency guard.
- Error schema: `{"error":{"code":"revision_conflict","message":"...","details":{}}}`. Do not leak absolute filesystem paths.
- JSON list responses support documented pagination/limit before large-workspace usage.

## Routes
| Method | Route | Purpose |
|---|---|---|
| POST | `/auth/login` | Establish session |
| POST | `/auth/logout` | Revoke session |
| GET | `/auth/me` | Current principal + CSRF token/metadata |
| GET | `/workspace/tree?path=` | List immediate children of directory |
| GET | `/files/metadata?path=` | Classify an authenticated regular file for editor/viewer dispatch |
| GET | `/files/content?path=` | Read bounded text with revision, encoding, metadata |
| PUT | `/files/content?path=` | Update existing text, conditional revision required |
| POST | `/files` | Create empty/text file only if absent |
| POST | `/directories` | Create directory |
| PATCH | `/entries/move` | Rename/move file or directory |
| DELETE | `/entries?path=` | Move entry to trash |
| GET | `/trash` | List restorable entries |
| POST | `/trash/{id}/restore` | Restore, reject collisions |
| POST | `/uploads?directory=` | Multipart stream upload with name collision policy |
| GET | `/files/download?path=` | Authenticated attachment download |
| GET | `/files/preview?path=` | Strict-safe inline previews (type and CSP controls) |
| GET | `/search?q=&limit=` | File and full-text search |
| GET | `/settings` | Preferences and limits exposed safely |
| PATCH | `/settings` | Change editable preferences |
| GET | `/healthz` | Process liveness; no internal info |

## Core examples
Read: `GET /api/v1/files/content?path=Linux%2Fnotes.md`
```json
{"path":"Linux/notes.md","kind":"text","content":"# Notes\n","encoding":"utf-8","revision":"sha256:opaque","size":8,"mtime":"2026-10-15T09:00:00Z"}
```
For JSON content reads, `revision` is the response field; server may also send `ETag`. `sha256:opaque` is an illustrative value, not a mandated exact algorithm. Never decode and re-encode arbitrary binary files via this endpoint.

Write: `PUT /api/v1/files/content?path=Linux%2Fnotes.md`
Headers: `Content-Type: application/json`, `If-Match: "sha256:opaque"`, CSRF header.
```json
{"content":"# Updated\n","encoding":"utf-8"}
```
Success `200`: `{"path":"Linux/notes.md","revision":"sha256:new","savedAt":"..."}`. Conflict `412 Precondition Failed` with current revision metadata; invalid/unreadable files `415/422` as appropriate. Missing precondition `428 Precondition Required`. Create-only collisions return `409 Conflict`.

Move request:
```json
{"from":"Linux/old.md","to":"Linux/new.md"}
```
Moves must reject target collision unless an explicit separate policy is later specified. Do not automatically rewrite Markdown links in V1; communicate impact.

### Selected error codes
`unauthenticated` (401), `forbidden` (403), `not_found` (404), `path_invalid` (400), `unsupported_file_type` (415), `too_large` (413), `revision_conflict` (412), `precondition_required` (428), `target_exists` (409), `rate_limited` (429), `internal_error` (500).

## Browser autosave protocol
1. Fetch file content and opaque revision.
2. Keep in-memory editing session (text, baseRevision, dirty status).
3. Debounce and send a conditional write; serialize writes for that file.
4. On 200 update base revision and clean state only if the response matches the last acknowledged snapshot. If edits occurred during request, remain dirty and enqueue next save.
5. On 412 preserve local content, stop blind retries, show compare/keep separate options.
6. On network error preserve dirty content and retry with bounded backoff only if base revision remains valid.

## Security notes
Authenticated downloads use correct `Content-Disposition` and `X-Content-Type-Options: nosniff`. Raw HTML/SVG must not execute in the app's origin. URL path normalization + filesystem-level race protection are mandatory. Session cookies are HttpOnly, Secure under HTTPS, SameSite; mutation endpoints enforce CSRF. Upload streaming applies size limits independently of declared Content-Length.

## Implemented status (M1, first two slices)

Implemented: health, login/logout/me, immediate-child tree listing, text content GET/PUT, create-only POST files, POST directories, metadata, uploads, authenticated downloads/previews and read-only GET settings. Other routes above remain proposed.

Tree: `path` defaults to the root (`""`), `offset` defaults to 0, `limit` defaults to 200 (maximum 1000). Response is `{entries:[{name,path,kind,size}],total,offset,limit}`; `kind` is `directory` or `file`. Unsafe entries are omitted. Pagination is not a filesystem snapshot.

Login body: `{username:"admin",password:"..."}`. Login and me return `{username,csrfToken}`. Mutations require `X-CSRF-Token` after login and the configured same-origin `Origin`; cross-site browser mutations are rejected. API responses use `Cache-Control: no-store`.

Additional errors: `file_changed` (409) when a read/parent identity changes during operation; `durability_uncertain` (500) when replacement completed but directory sync failed. Clients retain drafts and re-read before reconciliation. See `M1.md` for external-writer race boundaries; this contract does not assert atomic filesystem CAS against uncooperative external processes.

### Attachment contract

`GET /files/metadata?path=` returns `{path,size,mtime,mediaType,viewer}`. `viewer` is `markdown`, `text`, `image`, `pdf` or `binary`. Classification inspects actual bytes; special files, symlinks and hardlinks remain forbidden. SVG/HTML are never active previews.

`POST /uploads?directory=&image=false` requires one multipart part named `file`. The raw filename must be a basename; traversal is rejected, not silently stripped. `image=true` requires a supported, bounded raster image (clipboard/drop bridge). Success 201 returns the same metadata shape. Same-name files are rejected with 409, limits with 413, image-only/preview incompatibility with `preview_unavailable` (415). More than one part or an incomplete body never commits a target file. Multiple files use separate requests and are not transactional as a batch.

Download always uses attachment disposition and octet-stream. Preview allows only validated supported raster images or a bounded PDF header type, with a sandbox CSP and nosniff; the client renders PDFs through PDF.js canvas rather than HTML/plugin embedding. Range downloads are supported by the Go HTTP file response. No archive extraction exists.

`GET /settings` returns `{limits:{text,image,pdf,attachment,imagePixels}}` with byte counts, except imagePixels. Limits are startup configuration; PATCH settings is not yet implemented.
