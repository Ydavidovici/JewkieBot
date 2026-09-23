# Hybrid Opening Explorer Design Document

This document outlines the architecture and implementation steps for adding a comprehensive Opening Book / Explorer feature to JewkieBot's existing Analysis Page.

## Goal
To build a chess Opening Explorer that aggregates data from three distinct sources (Lichess global data, curated local master games, and local Polyglot `.bin` theory) and displays it alongside live Stockfish and JewkieBot engine evaluations.

## Architecture Overview

Whenever the user makes a move on the frontend, the current board FEN is sent to a single backend endpoint. The backend concurrently queries all three data sources, normalizes the data, and returns a unified JSON response. The frontend then renders this data in an "Opening Book" table.

### 1. Data Sources
*   **Lichess Global DB:** Proxy requests to `https://explorer.lichess.ovh/lichess`. Provides vast numbers of candidate moves and win-rates from general players.
*   **Local Master DB:** Queries the existing `dbClient.js` microservice to find matching master games. Provides curated win-rates and historical references.
*   **Local Polyglot Book:** Parses a local `.bin` file. Provides "pure theory" engine weights. Requires custom Zobrist hashing and binary search logic.

### 2. Unified API Response Schema
The new endpoint `GET /api/analysis/explorer?fen={fen}` will return:
```json
{
  "fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  "lichess": {
    "moves": [
      { "uci": "e2e4", "white": 45, "draw": 5, "black": 50, "total": 1200000 }
    ]
  },
  "masters": {
    "moves": [
      { "uci": "e2e4", "white": 30, "draw": 50, "black": 20, "total": 4500 }
    ]
  },
  "polyglot": {
    "moves": [
      { "uci": "e2e4", "weight": 100 },
      { "uci": "d2d4", "weight": 80 }
    ]
  }
}
```

## Proposed Changes

### Backend Changes

#### [NEW] `src/controllers/explorerController.ts`
- Controller responsible for accepting the FEN, validating it, and orchestrating the concurrent `Promise.all` calls to the fetchers.
- Normalizes the output into the unified JSON schema.

#### [NEW] `src/utils/polyglotReader.ts`
- **Technical Challenge:** Node.js utility to read standard Polyglot `.bin` files.
- Implements Polyglot-specific 64-bit Zobrist hashing.
- Performs binary searches through the 16-byte structs:
  - 64-bit Hash (Big Endian)
  - 16-bit Move
  - 16-bit Weight
  - 32-bit Learn

#### [MODIFY] `src/server.ts`
- Register `const explorerController = new ExplorerController(...)`
- Mount `app.get("/api/analysis/explorer", explorerController.getExplorerData)`

### Frontend Changes

#### [MODIFY] `src/pages/AnalysisPage.tsx`
- Add a new state: `const [explorerData, setExplorerData] = useState(null)`.
- Use a `useEffect` hook that listens to the `getDisplayFen()` value and fetches from `/api/analysis/explorer`.
- Add a UI layout toggle to show the `OpeningExplorer` component in the right-hand panel (either above the Engine streams or on a separate tab).

#### [NEW] `src/components/OpeningExplorer.tsx`
- A table component to render the candidate moves.
- Columns: Move | Games | Win/Draw/Loss Bar.
- Supports toggling between the three datasets (Lichess, Masters, Polyglot Theory).

## Implementation Roadmap

To avoid becoming overwhelmed, we will build this in three phases:

### Phase 1: MVP (Lichess API + Frontend)
1. Build `explorerController.ts` but *only* implement the Lichess API fetcher.
2. Register the route in `server.ts`.
3. Build the `OpeningExplorer.tsx` frontend component and wire it up to `AnalysisPage.tsx` so we can immediately see candidate moves on the board.

### Phase 2: Polyglot Theory (The Hard Technical Task)
1. Create `polyglotReader.ts`.
2. Implement Zobrist hashing.
3. Hook it into the `ExplorerController` so the frontend also receives "Pure Theory" weights alongside Lichess stats.

### Phase 3: Master DB Integration
1. Extend `dbClient.js` if necessary to support querying stats by FEN.
2. Hook it into the `ExplorerController`.
3. Add the "Masters" toggle to the frontend UI.
