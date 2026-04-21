import { tool } from "@opencode-ai/plugin";
import * as fmModule from "front-matter";
// front-matter CJS/ESM interop: the callable is on .default
const fm = fmModule.default as unknown as <T>(s: string) => { attributes: T; body: string; bodyBegin: number; frontmatter?: string };
import {
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, basename, relative } from "node:path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface KbaasConfig {
  databasePath?: string;
  kbPath?: string;
}

interface EntityFrontmatter {
  entityType: string;
  name: string;
  aliases?: string[];
  sources?: string[];
  related?: Record<string, string[]>;
  created?: string;
  updated?: string;
  [key: string]: unknown;
}

interface ManifestEntry {
  name: string;
  entityType: string;
  path: string;
  aliases: string[];
  sources: string[];
  related: Record<string, string[]>;
}

interface Manifest {
  universe: string;
  total: number;
  byType: Record<string, number>;
  entities: ManifestEntry[];
  lastUpdated: string;
}

function loadKbaasConfig(cwd: string): KbaasConfig {
  const configPath = join(cwd, ".kbaas", "kbaas.json");
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return {};
  }
}

function resolveKbPath(cwd: string): string {
  const config = loadKbaasConfig(cwd);
  return config.kbPath ?? "kb/";
}

function resolveUniverseDataPath(cwd: string, universe: string): string {
  const kbPath = resolveKbPath(cwd);
  return join(cwd, kbPath, universe, "data");
}

function getEntityTypeDirs(dataPath: string): string[] {
  if (!existsSync(dataPath)) return [];
  return readdirSync(dataPath, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
    .map((d) => d.name);
}

function parseFrontmatter(filePath: string): EntityFrontmatter | null {
  try {
    const content = readFileSync(filePath, "utf-8");
    const parsed = fm<EntityFrontmatter>(content);
    return parsed.attributes;
  } catch {
    return null;
  }
}

function buildManifest(cwd: string, universe: string): Manifest {
  const dataPath = resolveUniverseDataPath(cwd, universe);
  const entityTypes = getEntityTypeDirs(dataPath);
  const entities: ManifestEntry[] = [];
  const byType: Record<string, number> = {};

  for (const entityType of entityTypes) {
    const typeDir = join(dataPath, entityType);
    const files = readdirSync(typeDir).filter(
      (f) => f.endsWith(".md") && !f.startsWith("_")
    );
    byType[entityType] = files.length;

    for (const file of files) {
      const filePath = join(typeDir, file);
      const attrs = parseFrontmatter(filePath);
      const name = attrs?.name ?? basename(file, ".md");
      entities.push({
        name,
        entityType,
        path: relative(cwd, filePath).replace(/\\/g, "/"),
        aliases: attrs?.aliases ?? [],
        sources: attrs?.sources ?? [],
        related: attrs?.related ?? {},
      });
    }
  }

  return {
    universe,
    total: entities.length,
    byType,
    entities,
    lastUpdated: new Date().toISOString(),
  };
}

function getManifestPath(cwd: string, universe: string): string {
  const dataPath = resolveUniverseDataPath(cwd, universe);
  return join(dataPath, "_manifest.json");
}

function isManifestFresh(cwd: string, universe: string): boolean {
  const manifestPath = getManifestPath(cwd, universe);
  if (!existsSync(manifestPath)) return false;

  const manifestStat = statSync(manifestPath);
  const dataPath = resolveUniverseDataPath(cwd, universe);
  const entityTypes = getEntityTypeDirs(dataPath);

  for (const entityType of entityTypes) {
    const typeDir = join(dataPath, entityType);
    const files = readdirSync(typeDir).filter(
      (f) => f.endsWith(".md") && !f.startsWith("_")
    );
    for (const file of files) {
      const fileStat = statSync(join(typeDir, file));
      if (fileStat.mtimeMs > manifestStat.mtimeMs) return false;
    }
  }
  return true;
}

function getOrBuildManifest(cwd: string, universe: string): Manifest {
  if (isManifestFresh(cwd, universe)) {
    try {
      const raw = readFileSync(getManifestPath(cwd, universe), "utf-8");
      return JSON.parse(raw);
    } catch {
      // Fall through to rebuild
    }
  }
  const manifest = buildManifest(cwd, universe);
  const manifestPath = getManifestPath(cwd, universe);
  const dataPath = resolveUniverseDataPath(cwd, universe);
  if (existsSync(dataPath)) {
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
  }
  return manifest;
}

// ---------------------------------------------------------------------------
// Tool: kb-index
// ---------------------------------------------------------------------------

export default tool({
  description:
    "Query the knowledge base index for a universe. List all entities, get stats, or rebuild the manifest. Use action='list' to get entity names by type, action='stats' for summary statistics, action='rebuild' to force-rebuild the manifest from disk.",
  args: {
    universe: tool.schema
      .string()
      .describe("Universe slug (e.g. 'willverse')"),
    action: tool.schema
      .enum(["list", "stats", "rebuild"])
      .describe("Action to perform: list, stats, or rebuild"),
    type: tool.schema
      .string()
      .optional()
      .describe(
        "Filter to a specific entity type (e.g. 'characters'). Optional."
      ),
  },
  async execute(args, context) {
    const cwd = context.directory;
    const { universe, action, type } = args;
    const dataPath = resolveUniverseDataPath(cwd, universe);

    if (!existsSync(dataPath)) {
      return `No data/ directory found for universe '${universe}' at ${dataPath}. The KB may be empty — run the writer to populate it.`;
    }

    if (action === "rebuild") {
      const manifest = buildManifest(cwd, universe);
      const manifestPath = getManifestPath(cwd, universe);
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
      return JSON.stringify(
        {
          action: "rebuild",
          universe,
          total: manifest.total,
          byType: manifest.byType,
          lastUpdated: manifest.lastUpdated,
          message: `Manifest rebuilt. ${manifest.total} entities indexed.`,
        },
        null,
        2
      );
    }

    const manifest = getOrBuildManifest(cwd, universe);

    if (action === "stats") {
      const sourceSet = new Set<string>();
      for (const e of manifest.entities) {
        for (const s of e.sources) sourceSet.add(s);
      }
      return JSON.stringify(
        {
          action: "stats",
          universe,
          total: manifest.total,
          byType: manifest.byType,
          sourcesCovered: Array.from(sourceSet),
          lastUpdated: manifest.lastUpdated,
        },
        null,
        2
      );
    }

    // action === "list"
    const grouped: Record<string, string[]> = {};
    for (const e of manifest.entities) {
      if (type && e.entityType !== type) continue;
      if (!grouped[e.entityType]) grouped[e.entityType] = [];
      grouped[e.entityType].push(e.name);
    }

    const filteredTotal = Object.values(grouped).reduce(
      (sum, arr) => sum + arr.length,
      0
    );

    return JSON.stringify(
      {
        action: "list",
        universe,
        total: filteredTotal,
        entities: grouped,
      },
      null,
      2
    );
  },
});
