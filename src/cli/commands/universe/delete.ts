import { Command } from "commander";
import { deleteUniversesBySlugs } from "../../../services/universe";

const collectSlugs = (value: string, previous: string[]): string[] => {
  const slugs = value
    .split(",")
    .map((slug) => slug.trim())
    .filter(Boolean);
  return [...previous, ...slugs];
};

export const deleteUniverseCommand = new Command("delete")
  .description("Delete universes by slug")
  .option(
    "--slug <slug>",
    "Universe slug (repeat --slug or use comma-separated values)",
    collectSlugs,
    [],
  )
  .action(async (options: { slug: string[] }) => {
    const slugs = [...new Set(options.slug)];

    if (slugs.length === 0) {
      console.error("Please provide at least one --slug value.");
      process.exitCode = 1;
      return;
    }

    const result = await deleteUniversesBySlugs(slugs);

    if (result.foundSlugs.length === 0) {
      console.error(`No universes found for slugs: ${slugs.join(", ")}.`);
      process.exitCode = 1;
      return;
    }

    console.log(`Deleted universes: ${result.foundSlugs.join(", ")}.`);

    if (result.missingSlugs.length > 0) {
      console.error(`Universe slugs not found: ${result.missingSlugs.join(", ")}.`);
      process.exitCode = 1;
    }
  });
