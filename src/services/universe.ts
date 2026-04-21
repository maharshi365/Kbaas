import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inArray } from "drizzle-orm";
import { resolveKbPath } from "../config/kbaas";
import { db } from "../db";
import { universes } from "../db/schema";

const UNIVERSE_SUBDIRECTORIES = ["_meta", "_inbox", "_raw"] as const;

const ENTITIES_FILE_NAME = "entities.json";
const ENTITIES_SCHEMA_URL =
  "https://raw.githubusercontent.com/maharshi365/Kbaas/main/schemas/entities.schema.json";

const ENTITIES_FILE_TEMPLATE = {
  schema: ENTITIES_SCHEMA_URL,
  value: [] as unknown[],
};

type CreateUniverseOptions = {
  name: string;
  slug: string;
};

type DeleteUniversesResult = {
  foundSlugs: string[];
  missingSlugs: string[];
};

export const createUniverse = async (
  options: CreateUniverseOptions,
): Promise<void> => {
  await db.insert(universes).values({
    name: options.name,
    slug: options.slug,
  });

  const universeDirectory = join(resolveKbPath(), options.slug);
  mkdirSync(universeDirectory, { recursive: true });

  for (const subdirectory of UNIVERSE_SUBDIRECTORIES) {
    mkdirSync(join(universeDirectory, subdirectory), { recursive: true });
  }

  writeFileSync(
    join(universeDirectory, "_meta", ENTITIES_FILE_NAME),
    `${JSON.stringify(ENTITIES_FILE_TEMPLATE, null, 2)}\n`,
  );
};

export const deleteUniversesBySlugs = async (
  slugs: string[],
): Promise<DeleteUniversesResult> => {
  const rows = await db
    .select()
    .from(universes)
    .where(inArray(universes.slug, slugs));

  if (rows.length === 0) {
    return {
      foundSlugs: [],
      missingSlugs: slugs,
    };
  }

  const foundSlugs = rows.map((row) => row.slug);
  const missingSlugs = slugs.filter((slug) => !foundSlugs.includes(slug));

  await db.delete(universes).where(inArray(universes.slug, foundSlugs));

  const kbRoot = resolveKbPath();
  for (const slug of foundSlugs) {
    rmSync(join(kbRoot, slug), { recursive: true, force: true });
  }

  return {
    foundSlugs,
    missingSlugs,
  };
};
