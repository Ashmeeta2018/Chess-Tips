# Cloud Sync API Contract

This app syncs profile-scoped learning data by profile ID.

## Base URL

Use `VITE_CLOUD_SYNC_ENDPOINT` in the frontend.

Example:

- `http://localhost:8787`

## Auth

If your backend is protected, set `VITE_CLOUD_SYNC_TOKEN` and expect:

- `Authorization: Bearer <token>`

If token is empty or not configured, no auth header is sent.

## Endpoints

### PUT /profiles/:profileId

Upserts one profile payload.

Request body:

```json
{
  "profileId": "profile_123",
  "studyHistory": [
    {
      "id": "entry_1",
      "timestamp": "2026-01-01T10:00:00.000Z",
      "fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
      "sideToMove": "w",
      "moveInput": "e4",
      "moveSan": "e4",
      "quality": "Best",
      "scoreLabel": "+0.35",
      "loss": 0,
      "warning": null,
      "comparison": "This move is tied with the top line."
    }
  ],
  "photoStudies": [
    {
      "id": "photo_1",
      "fileName": "board.png",
      "createdAt": "2026-01-01T10:05:00.000Z",
      "linkedFen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
      "previewDataUrl": "data:image/png;base64,..."
    }
  ]
}
```

Successful response:

```json
{
  "ok": true,
  "profileId": "profile_123",
  "payload": {
    "profileId": "profile_123",
    "studyHistory": [],
    "photoStudies": [],
    "updatedAt": "2026-01-01T10:10:00.000Z"
  }
}
```

### GET /profiles/:profileId

Fetches profile payload for pull-sync.

Successful response:

```json
{
  "ok": true,
  "profileId": "profile_123",
  "payload": {
    "profileId": "profile_123",
    "studyHistory": [],
    "photoStudies": [],
    "updatedAt": "2026-01-01T10:10:00.000Z"
  }
}
```

Not found response example:

```json
{
  "ok": false,
  "message": "No sync payload stored for profile profile_123."
}
```

## Behavior Notes

- The frontend treats `studyHistory` and `photoStudies` as arrays; missing arrays are treated as empty.
- Timestamps are ISO-8601 strings.
- The app scopes sync by active profile ID. Switch profiles before push/pull to sync the intended dataset.
