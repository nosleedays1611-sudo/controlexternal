# EXTERNAL Remote Server 2.0

Backend for the `3105-2.0-EXTERNAL-REMOTE-PHASE2` client. This package intentionally contains **no admin HTML yet**; the frontend can be added later under `public/` without changing the API.

## What is already implemented

- Exact `schema: 2` config consumed by the iOS app.
- SQLite persistence using Node's built-in `node:sqlite`.
- Initial seed matching the PHASE2 tabs, features and patch IDs.
- Remote hide/show and enable/disable for tabs and features.
- Remote rename/reorder/category/game/image/patch mapping changes.
- Raw `.3105` upload from the future admin site.
- Automatic SHA-256 and byte-size metadata.
- Immutable patch version history.
- Patch rollback and unpublish.
- Global monotonic `revision` increment on every client-visible change.
- Public patch endpoint exactly at `/api/patches/:id`, matching `RemoteConfigStore.patchURL(id:)`.
- Admin username/password sessions plus optional permanent admin bearer token.
- Login throttling, request limits, security headers and audit log.
- Atomic file uploads and SQLite WAL mode.
- systemd and Nginx deployment templates.
- Backup/restore scripts.
- No npm dependencies.

## Requirement

Node.js 24 is recommended. Node 22.5+ is the minimum because this server uses `node:sqlite`.

## First local run

```bash
cp .env.example .env
```

Edit `.env` and set at least:

```env
ADMIN_USER=nextaway
ADMIN_PASSWORD=A_LONG_RANDOM_PASSWORD
```

Start it with:

```bash
npm start
```

`npm start` loads `.env` with Node's built-in `--env-file` support; there are no npm packages to install.

Then:

```bash
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/api/config
```

The SQLite database is created on first boot in:

```text
data/external-remote.sqlite3
```

Patch files are stored under:

```text
data/patches/<patch-id>/v<version>.3105
```

## Login test

```bash
curl -X POST http://127.0.0.1:3000/api/admin/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"nextaway","password":"A_LONG_RANDOM_PASSWORD"}'
```

Copy the returned token:

```bash
export TOKEN='TOKEN_HERE'
```

## Hide NO RELOG

```bash
curl -X PATCH http://127.0.0.1:3000/api/admin/tabs/no-relog \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"visible":false}'
```

Put it back:

```bash
curl -X PATCH http://127.0.0.1:3000/api/admin/tabs/no-relog \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"visible":true}'
```

## Publish .3105

The admin HTML will later send the file bytes with this same request:

```bash
curl -X PUT http://127.0.0.1:3000/api/admin/patches/fn-normal-hs-alto-sem/file \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/octet-stream' \
  -H 'X-Patch-File-Name: fn-normal-hs-alto-sem.3105' \
  -H 'X-Patch-Password: 0' \
  --data-binary @fn-normal-hs-alto-sem.3105
```

The client then sees the new `version`, `sha256`, and `size` in `/api/config`. It downloads the bytes from:

```text
GET /api/patches/fn-normal-hs-alto-sem
```

## VPS layout

Recommended:

```text
/opt/external-remote/
├── server.js
├── database.js
├── config.js
├── lib/
├── public/
├── data/
├── backups/
├── .env
└── seed-config.json
```

The app should eventually use:

```text
https://YOUR-DOMAIN/api/config
```

as `ExternalRemoteConfigURL`.

See `API.md` for every endpoint and `deploy/` for systemd/Nginx templates.
