import { Command } from "commander";
import { desc } from "drizzle-orm";
import { db } from "../../../db";
import { universes } from "../../../db/schema";

export const listUniverseCommand = new Command("list")
  .description("List all universes")
  .action(async () => {
    const rows = await db
      .select()
      .from(universes)
      .orderBy(desc(universes.createdAt));

    if (rows.length === 0) {
      console.log("No universes found.");
      return;
    }

    console.table(
      rows.map((row) => ({
        name: row.name,
        slug: row.slug,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      })),
    );
  });
