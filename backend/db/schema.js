import {sql} from "drizzle-orm";
import {sqliteTable, integer, text, index} from "drizzle-orm/sqlite-core";

export const players = sqliteTable("players", {
    id: integer("id").primaryKey({autoIncrement: true}),
    name: text("name").notNull().unique(),
});

export const games = sqliteTable("games", {
    id: integer("id").primaryKey({autoIncrement: true}),
    whiteId: integer("white_id").notNull().references(() => players.id),
    blackId: integer("black_id").notNull().references(() => players.id),
    result: text("result"),
    termination: text("termination"),
    startedAt: text("started_at").default(sql`CURRENT_TIMESTAMP`),
    finishedAt: text("finished_at"),
    source: text("source").default("local"),
    lichessGameId: text("lichess_game_id").unique(),
    variant: text("variant"),
    rated: integer("rated"),
    timeControl: text("time_control"),
    whiteRating: integer("white_rating"),
    blackRating: integer("black_rating"),
    openingEco: text("opening_eco"),
    openingName: text("opening_name"),
});

export const gameMoves = sqliteTable("game_moves", {
    id: integer("id").primaryKey({autoIncrement: true}),
    gameId: integer("game_id").notNull().references(() => games.id, {onDelete: "cascade"}),
    ply: integer("ply").notNull(),
    uci: text("uci").notNull(),
    fenAfter: text("fen_after"),
}, (table) => {
    return {
        gameIdx: index("game_idx").on(table.gameId),
    };
});

export const moveEvals = sqliteTable("move_evals", {
    id: integer("id").primaryKey({autoIncrement: true}),
    gameId: integer("game_id").notNull().references(() => games.id, {onDelete: "cascade"}),
    ply: integer("ply").notNull(),
    bestUci: text("best_uci"),
    bestCp: integer("best_cp"),
    playedCp: integer("played_cp"),
    cpLoss: integer("cp_loss"),
    isMate: integer("is_mate").default(0),
    classification: text("classification"),
}, (table) => ({
    gameIdx: index("move_evals_game_idx").on(table.gameId),
}));
