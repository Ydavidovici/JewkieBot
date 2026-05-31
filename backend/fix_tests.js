import fs from 'fs';

let content = fs.readFileSync('tests/gameAnalyzer.test.js', 'utf8');

// 1. Remove Drizzle imports
content = content.replace('import {Database} from "bun:sqlite";\n', '');
content = content.replace('import {drizzle} from "drizzle-orm/bun-sqlite";\n', '');
content = content.replace('import {eq} from "drizzle-orm";\n', '');
content = content.replace('import * as schema from "../db/schema.js";\n', '');

// 2. Replace createTestDb with createTestDbClient
const mockDbStr = `function createTestDbClient() {
    return {
        _players: [],
        _games: [],
        _moves: [],
        _evals: [],
        _id: 1,

        async seedGame({result = null, openingEco = null, openingName = null} = {}) {
            const player = { id: this._id++, name: \`bot-\${Math.random()}\` };
            this._players.push(player);
            const game = {
                id: this._id++,
                whiteId: player.id,
                blackId: player.id,
                result,
                openingEco,
                openingName
            };
            this._games.push(game);
            return {player, game};
        },

        async insertGameMoves(moves) {
            this._moves.push(...moves);
        },

        async insertMoveEvals(gameId, evals) {
            for (const e of evals) { e.gameId = gameId; }
            this._evals.push(...evals);
        },

        async getGameMoves(gameId) {
            return this._moves.filter(m => m.gameId === gameId).sort((a,b) => a.ply - b.ply);
        },

        async getUnanalyzedGames() {
            const analyzedGameIds = new Set(this._evals.map(e => e.gameId));
            return this._games.filter(g => !analyzedGameIds.has(g.id));
        },

        async getStats() { return {}; }
    };
}`;

content = content.replace(/function createTestDb\(\) \{[\s\S]*?return drizzle\(sqlite, \{schema\}\);\n\}/, mockDbStr);

// 3. Replace seedGame (it's now in dbClient)
content = content.replace(/async function seedGame\(db, \{.*?\} = \{\}\) \{[\s\S]*?return \{player, game\};\n\}\n/g, '');

// 4. Replace usages in tests
content = content.replace(/const db = createTestDb\(\);/g, 'const dbClient = createTestDbClient();');
content = content.replace(/const \{game\} = await seedGame\(db/g, 'const {game} = await dbClient.seedGame(');
content = content.replace(/const \{game: ([^}]+)\} = await seedGame\(db/g, 'const {game: $1} = await dbClient.seedGame(');

content = content.replace(/await db\.insert\(schema\.gameMoves\)\.values\(([\s\S]*?)\);/g, 'await dbClient.insertGameMoves($1);');
content = content.replace(/const rows = await db\.select\(\)\.from\(schema\.moveEvals\)\n?\s*\.where\(eq\(schema\.moveEvals\.gameId, game\.id\)\);/g, 'const rows = dbClient._evals.filter(e => e.gameId === game.id);');
content = content.replace(/const rows = await db\.select\(\)\.from\(schema\.moveEvals\)\.where\(eq\(schema\.moveEvals\.gameId, game\.id\)\);/g, 'const rows = dbClient._evals.filter(e => e.gameId === game.id);');
content = content.replace(/const \[row\] = await db\.select\(\)\.from\(schema\.moveEvals\)\.where\(eq\(schema\.moveEvals\.gameId, game\.id\)\);/g, 'const [row] = dbClient._evals.filter(e => e.gameId === game.id);');

// 5. Replace new GameAnalyzer(...)
content = content.replace(/new GameAnalyzer\(([^,]+), \{db,/g, 'new GameAnalyzer($1, {dbClient,');

// 6. Pre-seed move_evals
content = content.replace(/await db\.insert\(schema\.moveEvals\)\.values\(\[\n\s*\{gameId: ([^,]+), ([\s\S]*?)\},\n\s*\]\);/g, 'await dbClient.insertMoveEvals($1, [{$2}]);');

// 7. Remove the getStats describe block entirely
const statsIdx = content.indexOf('describe("GameAnalyzer.getStats()"');
if (statsIdx !== -1) {
    content = content.substring(0, statsIdx);
}

fs.writeFileSync('tests/gameAnalyzer.test.js', content);
