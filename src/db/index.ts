import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { ensureDatabaseDirectory, resolveDatabasePath } from "../config/kbaas";

const databasePath = resolveDatabasePath();

ensureDatabaseDirectory(databasePath);

const sqlite = new Database(databasePath);

export const db = drizzle(sqlite);
