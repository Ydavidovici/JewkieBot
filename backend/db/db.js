import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { players, games, gameMoves, moveEvals } from "./schema.js";
import path from "node:path";

const __dirname = import.meta.dirname;

// Resolve to backend/myengine.db (one level up from this file) so the DB
// location is independent of where bun was launched from.
const sqlite = new Database(path.join(__dirname, "..", "myengine.db"), { create: true });

export const db = drizzle(sqlite, {
  schema: {
    players,
    games,
    gameMoves,
    moveEvals,
  },
});
