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
import { Output, NoObjectGeneratedError, generateText } from "ai";
import { google } from "@ai-sdk/google";
import { inArray } from "drizzle-orm";
import { resolveKbPath } from "../config/kbaas";
import { db } from "../db";
import { universes } from "../db/schema";
import { buildExtractionSchema, validateEntitiesFile } from "../utils/validate-entities";

const UNIVERSE_SUBDIRECTORIES = ["_meta", "_outbox", "_raw", "data"] as const;

const ENTITIES_FILE_NAME = "entities.json";
const ENTITIES_SCHEMA_URL =
  "https://raw.githubusercontent.com/maharshi365/Kbaas/main/schemas/entities.schema.json";

const CONCURRENCY_LIMIT = 10;
const MAX_RETRIES = 3;
const GOOGLE_MODEL = "gemini-flash-latest";
const EXTRACTOR_PROMPT_PATH = join(
  process.cwd(),
  "src",
  "prompts",
  "extractor-prompt.md",
);


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

type ProgressEvent =
  | { type: "discovery"; totalFiles: number; dirPath: string }
  | { type: "batch_start"; batchNumber: number; totalBatches: number; batchSize: number }
  | { type: "file_start"; fileName: string; index: number; total: number }
  | { type: "file_done"; fileName: string; index: number; total: number }
  | { type: "file_retry"; fileName: string; index: number; total: number; attempt: number; maxRetries: number; error: string }
  | { type: "file_error"; fileName: string; index: number; total: number; error: string }
  | { type: "batch_done"; batchNumber: number; totalBatches: number; succeeded: number; failed: number };

type LoadUniverseFileOptions = {
  slug: string;
  filePath?: string;
  dirPath?: string;
  onProgress?: (event: ProgressEvent) => void;
};

type FailedFile = {
  filePath: string;
  error: string;
};

type LoadUniverseFileResult = {
  outputPaths: string[];
  rawPaths: string[];
  failedFiles: FailedFile[];
};


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

  const { onProgress } = options;

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

    onProgress?.({ type: "discovery", totalFiles: sourceFiles.length, dirPath: resolvedDirPath });
  }

  const extractionSchema = buildExtractionSchema(entitiesFile);

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
  const failedFiles: FailedFile[] = [];
  const totalFiles = sourceFiles.length;

  // Chunk source files into batches of CONCURRENCY_LIMIT
  const batches: string[][] = [];
  for (let i = 0; i < sourceFiles.length; i += CONCURRENCY_LIMIT) {
    batches.push(sourceFiles.slice(i, i + CONCURRENCY_LIMIT));
  }

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx]!;
    const batchNumber = batchIdx + 1;
    const totalBatches = batches.length;
    const batchOffset = batchIdx * CONCURRENCY_LIMIT;

    onProgress?.({
      type: "batch_start",
      batchNumber,
      totalBatches,
      batchSize: batch.length,
    });

    const results = await Promise.allSettled(
      batch.map(async (sourceFilePath, i) => {
        const globalIndex = batchOffset + i + 1;
        const { fileName } = splitFilenameAndExtension(sourceFilePath);

        onProgress?.({
          type: "file_start",
          fileName,
          index: globalIndex,
          total: totalFiles,
        });

        const fileText = readFileSync(sourceFilePath, "utf-8");
        const rawPath = copyToRawDirectory(sourceFilePath, rawDirectory);

        let extraction: Awaited<ReturnType<typeof generateText>> | undefined;
        let lastError: unknown;

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
          try {
            extraction = await generateText({
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
            break;
          } catch (error) {
            lastError = error;

            if (NoObjectGeneratedError.isInstance(error) && attempt < MAX_RETRIES) {
              const reason = error.message || "response did not match schema";
              onProgress?.({
                type: "file_retry",
                fileName,
                index: globalIndex,
                total: totalFiles,
                attempt,
                maxRetries: MAX_RETRIES,
                error: reason,
              });
              continue;
            }

            throw error;
          }
        }

        if (!extraction) {
          throw lastError ?? new Error("Extraction failed after retries.");
        }

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

        onProgress?.({
          type: "file_done",
          fileName,
          index: globalIndex,
          total: totalFiles,
        });

        return { outputPath: outputFilePath, rawPath };
      }),
    );

    let batchSucceeded = 0;
    let batchFailed = 0;

    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      const sourceFilePath = batch[i]!;
      const globalIndex = batchOffset + i + 1;

      if (result.status === "fulfilled") {
        outputPaths.push(result.value.outputPath);
        rawPaths.push(result.value.rawPath);
        batchSucceeded++;
      } else {
        const errorMessage = result.reason instanceof Error
          ? result.reason.message
          : String(result.reason);
        const { fileName } = splitFilenameAndExtension(sourceFilePath);

        failedFiles.push({ filePath: sourceFilePath, error: errorMessage });
        batchFailed++;

        onProgress?.({
          type: "file_error",
          fileName,
          index: globalIndex,
          total: totalFiles,
          error: errorMessage,
        });
      }
    }

    onProgress?.({
      type: "batch_done",
      batchNumber,
      totalBatches,
      succeeded: batchSucceeded,
      failed: batchFailed,
    });
  }

  return {
    outputPaths,
    rawPaths,
    failedFiles,
  };
};
