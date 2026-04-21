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

export const getUniverseCommand = new Command("get")
  .description("Get universes by slug")
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

    const rowBySlug = new Map(rows.map((row) => [row.slug, row]));
    const missingSlugs = slugs.filter((slug) => !rowBySlug.has(slug));
    const orderedRows = slugs
      .map((slug) => rowBySlug.get(slug))
      .filter((row): row is NonNullable<typeof row> => Boolean(row));

    console.table(
      orderedRows.map((row) => ({
        name: row.name,
        slug: row.slug,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      })),
    );

    if (missingSlugs.length > 0) {
      console.error(`Universe slugs not found: ${missingSlugs.join(", ")}.`);
      process.exitCode = 1;
    }
  });
