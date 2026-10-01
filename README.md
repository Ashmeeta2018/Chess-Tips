# Chess Tips Coach

A learning-focused chess app that explains move choices instead of only showing a best line.

## What This MVP Includes

- Interactive chessboard with legal move handling
- Hash-based app screens (`#/board`, `#/coach`, `#/study`, `#/learn`)
- Move suggestions for the side to move
- Top move ranking with quality labels
- Candidate move review (`e4`, `Nf3`, `e2e4`) with "why" explanation
- Stockfish-backed candidate grading when Stockfish mode is active
- Configurable engine depth (1-4) and top-line count
- Optional Stockfish worker analysis mode (depth selectable)
- Custom FEN loading for studying any position
- Progress tracker saved in local storage (quality trends + reviewed positions)
- Profile-aware study history and photo libraries
- Cloud sync push/pull via configurable endpoint
- Photo study upload linked to the current position
- Auto-detect board from uploaded screenshots and generate a suggested FEN
- Low-confidence detection review flow with editable FEN dialog before loading
- Learning tracks from beginner to advanced
- Expansion placeholders for image, video, and live coaching modes

## Tech Stack

- React + TypeScript + Vite
- `chess.js` for legal move generation and position handling
- Custom lightweight evaluator + minimax search (configurable depth 1-4)
- Dynamic browser integrations:
	- `fenshot` (via CDN module) for screenshot-to-FEN recognition
	- Stockfish WASM worker bootstrap (via CDN script fetch)

## Run Locally

```bash
npm install
npm run dev
```

If your Y drive is low on space, use C-drive cache fallback scripts:

```bash
npm run dev:cdrive
npm run build:cdrive
```

These scripts mirror the project into `%LOCALAPPDATA%/ChessTipsMirror`, run Vite and TypeScript there, and keep source changes synced while dev mode is running.
For `build:cdrive`, generated `dist/` output is synced back into your workspace after a successful build.

Optional: run the local cloud sync mock server.

```bash
npm run mock:sync
```

Run contract checks against the mock sync API:

```bash
npm run test:sync-contract
```

Then configure frontend env values (see `.env.example`):

- `VITE_CLOUD_SYNC_ENDPOINT=http://localhost:8787`
- `VITE_CLOUD_SYNC_TOKEN=dev-sync-token`

Build for production:

```bash
npm run build
```

## CI

GitHub Actions validates every push and pull request to `main` by running:

- `npm run lint`
- `npm run test:sync-contract`
- `npm run build`

Workflow file: `.github/workflows/ci.yml`.

## Core Files

- `src/App.tsx`: UI, board interactions, candidate move workflow
- `src/lib/chessCoach.ts`: evaluation, ranking, and explanation generation
- `src/lib/boardRecognition.ts`: image recognition bridge for auto FEN detection
- `src/lib/stockfishWorker.ts`: Stockfish worker orchestration and parsing
- `src/lib/profileSync.ts`: profile management + cloud sync scaffolding
- `src/App.css` + `src/index.css`: responsive visual system
- `docs/cloud-sync-api.md`: concrete sync request/response contract
- `scripts/mock-cloud-sync-server.mjs`: local mock backend for sync testing

## Cloud Sync Contract

Use these profile-scoped endpoints:

- `PUT /profiles/:profileId` to push `studyHistory` + `photoStudies`
- `GET /profiles/:profileId` to pull synced payload

Full contract and JSON examples are in `docs/cloud-sync-api.md`.

## Suggested Next Milestones

1. Replace mock cloud sync with a production backend (Supabase/Firebase/custom API).
2. Add account-based auth so multiple devices sync securely per user.
3. Add live game integration (Lichess/Chess.com import) for real-time coaching.
4. Extend image study into video/live stream position detection.
