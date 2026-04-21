import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

export const DEFAULT_DATABASE_PATH = "meta/sqlite.db";
export const DEFAULT_KB_PATH = "kb/";

const CONFIG_DIRECTORY = ".kbaas";
const CONFIG_FILE = "kbaas.json";

type KbaasConfig = {
  databasePath?: string;
  kbPath?: string;
};

const kbaasConfigSchema = z.looseObject({
  databasePath: z.string().trim().min(1).optional(),
  kbPath: z.string().trim().min(1).optional(),
});

const configFilePath = (cwd: string): string =>
  join(cwd, CONFIG_DIRECTORY, CONFIG_FILE);

type LoadKbaasConfigOptions = {
  cwd?: string;
};

export const loadKbaasConfig = (
  options: LoadKbaasConfigOptions = {},
): KbaasConfig => {
  const cwd = options.cwd ?? process.cwd();
  const filePath = configFilePath(cwd);

  if (!existsSync(filePath)) {
    return {};
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    throw new Error(`Invalid JSON in ${CONFIG_DIRECTORY}/${CONFIG_FILE}.`);
  }

  const parsedConfig = kbaasConfigSchema.safeParse(parsed);

  if (!parsedConfig.success) {
    const issue = parsedConfig.error.issues[0];
    throw new Error(
      `Invalid ${CONFIG_DIRECTORY}/${CONFIG_FILE}: ${issue?.message ?? "validation failed"}.`,
    );
  }

  return {
    databasePath: parsedConfig.data.databasePath,
    kbPath: parsedConfig.data.kbPath,
  };
};

export const resolveDatabasePath = (
  options: LoadKbaasConfigOptions = {},
): string => loadKbaasConfig(options).databasePath ?? DEFAULT_DATABASE_PATH;

export const resolveKbPath = (
  options: LoadKbaasConfigOptions = {},
): string => loadKbaasConfig(options).kbPath ?? DEFAULT_KB_PATH;

export const ensureDatabaseDirectory = (databasePath: string): void => {
  mkdirSync(dirname(databasePath), { recursive: true });
};
