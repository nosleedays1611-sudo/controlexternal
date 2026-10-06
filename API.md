# EXTERNAL Remote Server API

All public client endpoints match the PHASE2 iOS contract.

## Public

- `GET /health`
- `GET /api/config`
- `GET /api/config/revision`
- `GET /api/patches/:id`
- `HEAD /api/patches/:id`

`GET /api/config` returns schema 2:

```json
{
  "schema": 2,
  "revision": 1,
  "pollIntervalSeconds": 30,
  "tabs": [],
  "features": [],
  "patches": []
}
```

## Admin authentication

### Login

`POST /api/admin/login`

```json
{
  "username": "nextaway",
  "password": "your-password"
}
```

The response contains a bearer token. Send it as:

```text
Authorization: Bearer SESSION_TOKEN
```

If `ADMIN_TOKEN` is configured, it is also accepted as a permanent bearer token.

### Logout

`POST /api/admin/logout`

## State/settings

- `GET /api/admin/state`
- `GET /api/admin/audit?limit=100`
- `PATCH /api/admin/settings` with `{ "pollIntervalSeconds": 30 }`

## Tabs

- `POST /api/admin/tabs`
- `PATCH /api/admin/tabs/:id`
- `DELETE /api/admin/tabs/:id`
- `DELETE /api/admin/tabs/:id?cascade=1`

Example hide NO RELOG:

```json
{ "visible": false }
```

## Features

- `POST /api/admin/features`
- `PATCH /api/admin/features/:id`
- `DELETE /api/admin/features/:id`

Example disable but keep visible:

```json
{ "enabled": false }
```

Example remove from UI:

```json
{ "visible": false }
```

## Patch records

- `POST /api/admin/patches`
- `PATCH /api/admin/patches/:id`
- `DELETE /api/admin/patches/:id`

Create record:

```json
{
  "id": "fn-normal-hs-alto-sem",
  "fileName": "fn-normal-hs-alto-sem.3105",
  "password": "0"
}
```

## Publish a .3105 file

`PUT /api/admin/patches/:id/file`

Body is the raw `.3105` bytes, not multipart form data.

Optional headers:

```text
X-Patch-File-Name: fn-normal-hs-alto-sem.3105
X-Patch-Password: 0
X-Patch-Note: update october
```

Example:

```bash
curl -X PUT \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/octet-stream" \
  -H "X-Patch-File-Name: fn-normal-hs-alto-sem.3105" \
  --data-binary @fn-normal-hs-alto-sem.3105 \
  https://remote.example.com/api/admin/patches/fn-normal-hs-alto-sem/file
```

The server calculates SHA-256, stores the file, creates a new immutable version, updates the current patch and increments the global config revision.

## Version history / rollback

- `GET /api/admin/patches/:id/versions`
- `POST /api/admin/patches/:id/rollback` with `{ "version": 3 }`
- `POST /api/admin/patches/:id/unpublish`

Rollback only changes which stored version is current. Old versions are retained.
