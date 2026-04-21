import { Command } from "commander";
import { inArray } from "drizzle-orm";
import { db } from "../../../db";
import { universes } from "../../../db/schema";

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

    const rows = await db
      .select()
      .from(universes)
      .where(inArray(universes.slug, slugs));

    if (rows.length === 0) {
      console.error(`No universes found for slugs: ${slugs.join(", ")}.`);
      process.exitCode = 1;
      return;
    }

    const foundSlugs = rows.map((row) => row.slug);
    const missingSlugs = slugs.filter((slug) => !foundSlugs.includes(slug));

    await db.delete(universes).where(inArray(universes.slug, foundSlugs));

    console.log(`Deleted universes: ${foundSlugs.join(", ")}.`);

    if (missingSlugs.length > 0) {
      console.error(`Universe slugs not found: ${missingSlugs.join(", ")}.`);
      process.exitCode = 1;
    }
  });
