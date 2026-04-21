import { Command } from "commander";
import { db } from "../../../db";
import { universes } from "../../../db/schema";

export const createUniverseCommand = new Command("create")
  .description("Create a universe")
  .requiredOption("--name <name>", "Universe name")
  .requiredOption("--slug <slug>", "Universe slug")
  .action(async (options: { name: string; slug: string }) => {
    try {
      await db.insert(universes).values({
        name: options.name,
        slug: options.slug,
      });

      console.log(`Created universe '${options.name}' with slug '${options.slug}'.`);
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.includes("UNIQUE constraint failed") ||
          error.message.includes("universes.slug"))
      ) {
        console.error(`Universe slug '${options.slug}' already exists.`);
        process.exitCode = 1;
        return;
      }

      throw error;
    }
  });
