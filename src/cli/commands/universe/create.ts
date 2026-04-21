import { Command } from "commander";
import { createUniverse } from "../../../services/universe";

export const createUniverseCommand = new Command("create")
  .description("Create a universe")
  .requiredOption("--name <name>", "Universe name")
  .requiredOption("--slug <slug>", "Universe slug")
  .action(async (options: { name: string; slug: string }) => {
    try {
      await createUniverse({
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
