import { defineConfig } from "drizzle-kit";
import { resolveDatabasePath } from "../config/kbaas";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: resolveDatabasePath(),
  },
});
