import { Database } from "bun:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(__dirname, "..", "jewkiebot.db"));

db.exec(`
    CREATE TABLE IF NOT EXISTS move_evals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        ply INTEGER NOT NULL,
        best_uci TEXT,
        best_cp INTEGER,
        played_cp INTEGER,
        cp_loss INTEGER,
        is_mate INTEGER DEFAULT 0,
        classification TEXT
    )
`);

try {
    db.exec("CREATE INDEX IF NOT EXISTS move_evals_game_idx ON move_evals(game_id)");
} catch (_) {}

const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
console.log("Tables:", tables.map(t => t.name).join(", "));
db.close();
console.log("Migration complete.");
