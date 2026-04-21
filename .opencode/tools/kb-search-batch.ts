import { tool } from "@opencode-ai/plugin";
import * as fmModule from "front-matter";
const fm = fmModule.default as unknown as <T>(s: string) => { attributes: T; body: string; bodyBegin: number; frontmatter?: string };
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, basename, relative } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface KbaasConfig {
  databasePath?: string;
  kbPath?: string;
}

interface EntityFrontmatter {
  entityType: string;
  name: string;
  aliases?: string[];
  [key: string]: unknown;
}

interface SearchMatch {
  name: string;
  path: string;
  entityType: string;
  matchType: "exact" | "alias" | "case-insensitive" | "fuzzy";
  score: number;
}

interface QueryResult {
  query: string;
  type?: string;
  found: boolean;
  matches: SearchMatch[];
}

interface EntityEntry {
  filePath: string;
  relPath: string;
  entityType: string;
  name: string;
  aliases: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function fuzzyScore(a: string, b: string): number {
  const al = a.toLowerCase();
  const bl = b.toLowerCase();

  if (al === bl) return 1.0;
  if (al.includes(bl) || bl.includes(al)) return 0.7;

  const m = al.length;
  const n = bl.length;
  if (m === 0 || n === 0) return 0;

  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array(n + 1).fill(0)
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (al[i - 1] === bl[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  const lcs = dp[m][n];
  return (2 * lcs) / (m + n);
}

// ---------------------------------------------------------------------------
// Build entity index (scan once, search many)
// ---------------------------------------------------------------------------

function buildEntityIndex(
  cwd: string,
  dataPath: string,
  entityTypes: string[]
): EntityEntry[] {
  const entries: EntityEntry[] = [];

  for (const entityType of entityTypes) {
    const typeDir = join(dataPath, entityType);
    if (!existsSync(typeDir)) continue;

    const files = readdirSync(typeDir).filter(
      (f) => f.endsWith(".md") && !f.startsWith("_")
    );

    for (const file of files) {
      const filePath = join(typeDir, file);
      const attrs = parseFrontmatter(filePath);
      const name = attrs?.name ?? basename(file, ".md");
      const aliases = attrs?.aliases ?? [];
      const relPath = relative(cwd, filePath).replace(/\\/g, "/");

      entries.push({ filePath, relPath, entityType, name, aliases });
    }
  }

  return entries;
}

function searchOne(
  query: string,
  entries: EntityEntry[],
  enableFuzzy: boolean
): SearchMatch[] {
  const matches: SearchMatch[] = [];
  const queryLower = query.toLowerCase().trim();

  for (const entry of entries) {
    const { name, relPath, entityType, aliases } = entry;

    // Exact match on name
    if (name === query) {
      matches.push({ name, path: relPath, entityType, matchType: "exact", score: 1.0 });
      continue;
    }

    // Exact match on alias
    if (aliases.includes(query)) {
      matches.push({ name, path: relPath, entityType, matchType: "alias", score: 0.95 });
      continue;
    }

    // Case-insensitive match on name
    if (name.toLowerCase() === queryLower) {
      matches.push({ name, path: relPath, entityType, matchType: "case-insensitive", score: 0.9 });
      continue;
    }

    // Case-insensitive match on alias
    const aliasMatch = aliases.find((a) => a.toLowerCase() === queryLower);
    if (aliasMatch) {
      matches.push({ name, path: relPath, entityType, matchType: "alias", score: 0.85 });
      continue;
    }

    // Fuzzy match
    if (enableFuzzy) {
      const nameScore = fuzzyScore(queryLower, name.toLowerCase());
      const bestAliasScore = aliases.reduce(
        (best, a) => Math.max(best, fuzzyScore(queryLower, a.toLowerCase())),
        0
      );
      const score = Math.max(nameScore, bestAliasScore);
      if (score >= 0.5) {
        matches.push({
          name,
          path: relPath,
          entityType,
          matchType: "fuzzy",
          score: parseFloat(score.toFixed(3)),
        });
      }
    }
  }

  matches.sort((a, b) => b.score - a.score);
  return matches.slice(0, 5); // Top 5 per query (reduced from 10 for batch)
}

// ---------------------------------------------------------------------------
// Tool: kb-search-batch
// ---------------------------------------------------------------------------

export default tool({
  description:
    "Search for multiple entities in the knowledge base in a single call. " +
    "Accepts a JSON array of queries (each with query string and optional type filter). " +
    "Scans the filesystem once and runs all queries against the index. " +
    "Much more efficient than calling kb-search repeatedly.",
  args: {
    universe: tool.schema
      .string()
      .describe("Universe slug (e.g. 'willverse')"),
    queries: tool.schema
      .string()
      .describe(
        "JSON array of search queries. Each entry: {\"query\": \"Entity Name\", \"type\": \"characters\"} " +
        "(type is optional). Example: [{\"query\":\"Lindon\",\"type\":\"characters\"},{\"query\":\"Sacred Valley\",\"type\":\"locations\"}]"
      ),
    fuzzy: tool.schema
      .boolean()
      .optional()
      .describe(
        "Allow fuzzy matching (default: true). Set false for exact/alias/case-insensitive only."
      ),
  },
  async execute(args, context) {
    const cwd = context.directory;
    const { universe } = args;
    const enableFuzzy = args.fuzzy !== false;
    const dataPath = resolveUniverseDataPath(cwd, universe);

    // Parse queries
    let queryList: Array<{ query: string; type?: string }>;
    try {
      queryList = JSON.parse(args.queries);
      if (!Array.isArray(queryList)) {
        return JSON.stringify({ success: false, error: "queries must be a JSON array" });
      }
    } catch (e) {
      return JSON.stringify({ success: false, error: `Failed to parse queries JSON: ${e}` });
    }

    if (queryList.length === 0) {
      return JSON.stringify({ success: true, results: [], totalQueries: 0 });
    }

    if (!existsSync(dataPath)) {
      // KB is empty — all queries return not found
      const results: QueryResult[] = queryList.map((q) => ({
        query: q.query,
        type: q.type,
        found: false,
        matches: [],
      }));
      return JSON.stringify({ success: true, results, totalQueries: queryList.length, totalFound: 0 });
    }

    // Determine all entity types we need to scan
    const allTypes = getEntityTypeDirs(dataPath);
    const requestedTypes = new Set(queryList.map((q) => q.type).filter(Boolean) as string[]);
    const hasUntypedQueries = queryList.some((q) => !q.type);

    // Build index once — only scan needed type directories
    const typesToScan = hasUntypedQueries ? allTypes : allTypes.filter((t) => requestedTypes.has(t));
    const fullIndex = buildEntityIndex(cwd, dataPath, typesToScan);

    // If some queries have type filters and we only scanned a subset, build type-specific indexes
    // Actually since we scan all needed types above, we can just filter per-query
    const results: QueryResult[] = [];
    let totalFound = 0;

    for (const q of queryList) {
      const entries = q.type
        ? fullIndex.filter((e) => e.entityType === q.type)
        : fullIndex;

      const matches = searchOne(q.query, entries, enableFuzzy);
      const found = matches.length > 0;
      if (found) totalFound++;

      results.push({
        query: q.query,
        type: q.type,
        found,
        matches,
      });
    }

    return JSON.stringify(
      {
        success: true,
        universe,
        totalQueries: queryList.length,
        totalFound,
        results,
      },
      null,
      2
    );
  },
});
