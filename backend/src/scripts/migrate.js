import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Database } from "bun:sqlite";

const sqlite = new Database("myengine.db");
const db = drizzle({ client: sqlite });

await migrate(db, { migrationsFolder: "./db/migrations" });
console.log("Migrations applied.");
sqlite.close();
