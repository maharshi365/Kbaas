import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { parse, join, resolve } from "node:path";
import { Output, generateText } from "ai";
import { google } from "@ai-sdk/google";
import { inArray } from "drizzle-orm";
import { z } from "zod";
import { resolveKbPath } from "../config/kbaas";
import { db } from "../db";
import { universes } from "../db/schema";
import { validateEntitiesFile } from "../utils/validate-entities";

const UNIVERSE_SUBDIRECTORIES = ["_meta", "_outbox", "_raw", "data"] as const;

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

type LoadUniverseFileOptions = {
  slug: string;
  filePath?: string;
  dirPath?: string;
};

type LoadUniverseFileResult = {
  outputPaths: string[];
  rawPaths: string[];
};

const GOOGLE_MODEL = process.env.KBAAS_GEMINI_MODEL ?? "gemini-2.0-flash";
const EXTRACTOR_PROMPT_PATH = join(
  process.cwd(),
  "src",
  "prompts",
  "extractor-prompt.md",
);

const getAllFiles = (directoryPath: string): string[] => {
  const entries = readdirSync(directoryPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...getAllFiles(entryPath));
      continue;
    }

    if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files;
};

const ensureFile = (filePath: string): void => {
  if (!existsSync(filePath)) {
    throw new Error(`File does not exist: ${filePath}.`);
  }

  if (!lstatSync(filePath).isFile()) {
    throw new Error(`Path is not a file: ${filePath}.`);
  }
};

const splitFilenameAndExtension = (
  filePath: string,
): { fileName: string; extension: string } => {
  const { name: fileName, ext: extension } = parse(filePath);

  return {
    fileName,
    extension,
  };
};

const copyToRawDirectory = (
  sourceFilePath: string,
  rawRunDirectory: string,
): string => {
  const { fileName, extension } = splitFilenameAndExtension(sourceFilePath);
  const targetPath = join(rawRunDirectory, `${fileName}${extension}`);
  copyFileSync(sourceFilePath, targetPath);
  return targetPath;
};

const extractionPrompt = (entitiesDefinitionJson: string): string => {
  const template = readFileSync(EXTRACTOR_PROMPT_PATH, "utf-8");
  return template.replace("{{ENTITIES_DEFINITION_JSON}}", entitiesDefinitionJson);
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

export const loadUniverseFile = async (
  options: LoadUniverseFileOptions,
): Promise<LoadUniverseFileResult> => {
  if (Boolean(options.filePath) === Boolean(options.dirPath)) {
    throw new Error("Provide exactly one of --file or --dir.");
  }

  const universeDirectory = join(resolveKbPath(), options.slug);
  if (!existsSync(universeDirectory)) {
    throw new Error(
      `Universe '${options.slug}' was not found at ${universeDirectory}.`,
    );
  }

  const entitiesFilePath = join(universeDirectory, "_meta", ENTITIES_FILE_NAME);
  ensureFile(entitiesFilePath);

  const entitiesFile = validateEntitiesFile(entitiesFilePath);
  if (entitiesFile.value.length === 0) {
    throw new Error(
      `No entities configured in ${entitiesFilePath}. Add at least one entity before loading files.`,
    );
  }

  const resolvedFilePath = options.filePath ? resolve(options.filePath) : undefined;
  const resolvedDirPath = options.dirPath ? resolve(options.dirPath) : undefined;

  let sourceFiles: string[] = [];
  if (resolvedFilePath) {
    ensureFile(resolvedFilePath);
    sourceFiles = [resolvedFilePath];
  }

  if (resolvedDirPath) {
    if (!existsSync(resolvedDirPath)) {
      throw new Error(`Directory does not exist: ${resolvedDirPath}.`);
    }

    if (!lstatSync(resolvedDirPath).isDirectory()) {
      throw new Error(`Path is not a directory: ${resolvedDirPath}.`);
    }

    sourceFiles = getAllFiles(resolvedDirPath);
    if (sourceFiles.length === 0) {
      throw new Error(`No files found in directory: ${resolvedDirPath}.`);
    }
  }

  const [firstEntityName, ...restEntityNames] = entitiesFile.value.map(
    (entity) => entity.name,
  );
  const entityTypeSchema = z.enum([
    firstEntityName,
    ...restEntityNames,
  ] as [string, ...string[]]);

  const extractionSchema = z.object({
    entities: z.array(
      z.object({
        entityType: entityTypeSchema,
        value: z.string().trim().min(1),
        evidence: z.string().trim().min(1),
      }),
    ),
  });

  const rawDirectory = join(universeDirectory, "_raw");
  const outboxDirectory = join(universeDirectory, "_outbox");
  mkdirSync(rawDirectory, { recursive: true });
  mkdirSync(outboxDirectory, { recursive: true });

  const firstSourceFile = sourceFiles[0];
  if (!firstSourceFile) {
    throw new Error("No source files available for processing.");
  }

  const entitiesDefinitionJson = JSON.stringify(entitiesFile.value, null, 2);
  const prompt = extractionPrompt(entitiesDefinitionJson);

  const outputPaths: string[] = [];
  const rawPaths: string[] = [];

  for (const sourceFilePath of sourceFiles) {
    const fileText = readFileSync(sourceFilePath, "utf-8");
    const rawPath = copyToRawDirectory(sourceFilePath, rawDirectory);

    const extraction = await generateText({
      model: google(GOOGLE_MODEL),
      output: Output.object({ schema: extractionSchema }),
      system: prompt,
      messages: [
        {
          role: "user" as const,
          content: [
            {
              type: "text" as const,
              text: fileText,
            },
          ],
        },
      ],
    });

    const { fileName } = splitFilenameAndExtension(sourceFilePath);
    const outputFilePath = join(outboxDirectory, `${fileName}.entities.json`);

    writeFileSync(
      outputFilePath,
      `${JSON.stringify(
        {
          sourceFilePath,
          rawFilePath: rawPath,
          entities: extraction.output.entities,
        },
        null,
        2,
      )}\n`,
    );

    outputPaths.push(outputFilePath);
    rawPaths.push(rawPath);
  }

  return {
    outputPaths,
    rawPaths,
  };
};
