# Capture upload API

What the iOS app expects from the Gym Plan backend to upload a scan. The
server side is `backend/src/modules/captures.js`; the app side is
`lib/services/gym_plan_api.dart` and `lib/services/background_upload_queue.dart`.

It follows the PRD: the app talks only to the platform API, never to storage
directly; uploads go through **short-lived signed URLs**; an upload **resumes
rather than restarts** (APP-10); and the capture stays on the device **until
the platform confirms receipt** (APP-12).

## Shape

A capture is uploaded as one **S3 multipart upload per file**. The app splits
each file into fixed-size parts (8 MiB) and PUTs each part to its own signed
URL. A dropped connection only costs the part in flight.

```
app                              Gym Plan API                     S3
 │ POST /v1/captures ─────────────▶ create capture
 │ ◀──────────────────────── {captureId}
 │ POST /v1/captures/{id}/uploads ▶ CreateMultipartUpload per file,
 │                                  presign UploadPart per part
 │ ◀──────────────── {files: [{fileId, parts: [{number, url}]}]}
 │ PUT part bytes ──────────────────────────────────────────────────▶ (×N, in the background)
 │ POST /v1/captures/{id}/complete ▶ ListParts + CompleteMultipartUpload,
 │                                  verify sizes, enqueue plan reading
 │ ◀──────────────────── {status: "received"}
 │ delete local copy
```

All calls are `POST`, JSON in and out, over HTTPS, with
`Authorization: Bearer <access token>`.

## 1. Register a capture

`POST /v1/captures`

Header `Idempotency-Key: <string>`. The app retries this call after a lost
response with the same key. **The same key must return the same capture**,
not create a second one.

Request:

```json
{
  "facilityId": "fac_northgate",
  "facilityName": "Northgate Fitness",
  "level": 2,
  "floorToFloorM": 3.2,
  "source": "lidar",
  "coverage": 0.94,
  "closed": true,
  "overrideReason": null,
  "areaM2": 412.3,
  "durationSeconds": 540,
  "photoCount": 3,
  "weakWallCount": 1,
  "tags": [{ "type": "fireExit", "x": 4.1, "y": 0.2, "heightM": null }],
  "capturedAt": "2026-09-24T09:14:00Z"
}
```

- `source` is `lidar` for a real scan or `simulated` for a debug build's demo
  walk; the backend should reject `simulated` in production.
- `facilityId` comes from `GET /v1/facilities`. `facilityName` is also sent
  and accepted as a fallback for older app builds.
- Tag `x`/`y` are metres on the scan's floor plane (same frame as the model).
  `type` is one of `ceiling`, `fireExit`, `mirror`, `power`, `stair`.

Response `200`/`201`:

```json
{ "captureId": "cap_01H…" }
```

## 2. Open the uploads

`POST /v1/captures/{captureId}/uploads`

```json
{
  "partSize": 8388608,
  "files": [
    { "name": "scan.usdz",   "kind": "model", "bytes": 312475648, "contentType": "model/vnd.usdz+zip" },
    { "name": "scan.json",   "kind": "room",  "bytes": 48213,     "contentType": "application/json" },
    { "name": "photo-1.jpg", "kind": "photo", "bytes": 2811004,   "contentType": "image/jpeg" }
  ]
}
```

Response:

```json
{
  "files": [
    {
      "name": "scan.usdz",
      "fileId": "file_01H…",
      "parts": [
        { "number": 1, "url": "https://…s3…?partNumber=1&uploadId=…&X-Amz-Signature=…" },
        { "number": 2, "url": "…" }
      ]
    }
  ]
}
```

Rules the app relies on:

- One entry per requested file, matched by `name`.
- A file has exactly `max(1, ceil(bytes / partSize))` parts, numbered from 1.
  The app cuts part *n* as bytes `[(n-1)·partSize, min(n·partSize, bytes))`
  and **stops the upload if the count differs**.
- Each `url` accepts `PUT` with the raw part bytes as the body. The app sends
  `Content-Type: application/octet-stream`; do **not** sign `Content-Type`
  or any other header into the URL.
- URLs should stay valid for **at least 6 hours**. iOS may hold a queued
  background transfer for up to 4 hours before it starts.

## 3. Refresh expired URLs

`POST /v1/captures/{captureId}/uploads/refresh`

Called when parts failed (e.g. S3 answered `403` because the signature
expired after a long spell without signal).

```json
{ "files": [ { "fileId": "file_01H…", "parts": [2, 5] } ] }
```

Response: same shape as step 2, containing only the requested parts.

## 4. Confirm receipt

`POST /v1/captures/{captureId}/complete`

Body `{}`. The backend should:

1. `ListParts` for each file and `CompleteMultipartUpload` with the ETags
   (the app does not collect ETags; background transfers do not reliably
   expose response headers);
2. check each file's assembled size against the `bytes` it was opened with;
3. store the source immutably and queue plan reading;
4. answer:

```json
{ "status": "received" }
```

If some parts never arrived, the answer lists them, and the app resends
exactly those (with URLs from step 3) before asking again:

```json
{ "status": "incomplete", "missing": [{ "fileId": "file_01H…", "parts": [2] }] }
```

Only on `received` does the app delete its copy. Anything else is treated as
"not yet" and retried. The call must be **idempotent**: calling it again after
success must return `received` again, because the response can be lost.

## Errors

Error bodies should be `{ "message": "…" }`; the app shows `message` to the
surveyor when it stops an upload.

| Status          | App behaviour                                               |
| --------------- | ----------------------------------------------------------- |
| `401`           | Stops; resumes after the user signs in again.               |
| `408`/`429`/`5xx` | Retries with backoff (15 s doubling to 5 min).              |
| other `4xx`     | Stops and shows `message`; the user can tap *Try again*.    |
| no connection   | Waits and retries, shown as "Waiting for signal".           |

## Running the app against it

```sh
flutter run --dart-define=GYM_PLAN_API=https://api.gymplan.example
```

Without `GYM_PLAN_API` the app uses `http://localhost:8080`, a backend
running on the same computer (see `backend/README.md`).
