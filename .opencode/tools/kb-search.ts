import { tool } from "@opencode-ai/plugin";
import * as fmModule from "front-matter";
const fm = fmModule.default as unknown as <T>(s: string) => { attributes: T; body: string; bodyBegin: number; frontmatter?: string };
import { existsSync, readFileSync, readdirSync } from "node:fs";
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
  [key: string]: unknown;
}

interface SearchMatch {
  name: string;
  path: string;
  entityType: string;
  matchType: "exact" | "alias" | "case-insensitive" | "fuzzy";
  score: number;
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

/**
 * Compute a simple similarity score between two strings.
 * Returns 0.0 - 1.0 based on longest common subsequence ratio.
 */
function fuzzyScore(a: string, b: string): number {
  const al = a.toLowerCase();
  const bl = b.toLowerCase();

  if (al === bl) return 1.0;
  if (al.includes(bl) || bl.includes(al)) return 0.7;

  // LCS-based similarity
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
// Tool: kb-search
// ---------------------------------------------------------------------------

export default tool({
  description:
    "Search for an entity in the knowledge base by name. Supports exact match, alias match, case-insensitive match, and fuzzy match. Returns matching entities sorted by relevance score. Use this to check if an entity already exists before creating it.",
  args: {
    universe: tool.schema
      .string()
      .describe("Universe slug (e.g. 'willverse')"),
    query: tool.schema
      .string()
      .describe("Entity name to search for (e.g. 'Veylan', 'The Cube')"),
    type: tool.schema
      .string()
      .optional()
      .describe(
        "Narrow search to a specific entity type (e.g. 'characters'). Optional."
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
    const { universe, query, type } = args;
    const enableFuzzy = args.fuzzy !== false;
    const dataPath = resolveUniverseDataPath(cwd, universe);

    if (!existsSync(dataPath)) {
      return JSON.stringify({
        found: false,
        matches: [],
        message: `No data/ directory found for universe '${universe}'. KB may be empty.`,
      });
    }

    const entityTypes = type ? [type] : getEntityTypeDirs(dataPath);
    const matches: SearchMatch[] = [];
    const queryLower = query.toLowerCase().trim();

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

        // Exact match on name
        if (name === query) {
          matches.push({
            name,
            path: relPath,
            entityType,
            matchType: "exact",
            score: 1.0,
          });
          continue;
        }

        // Exact match on alias
        if (aliases.includes(query)) {
          matches.push({
            name,
            path: relPath,
            entityType,
            matchType: "alias",
            score: 0.95,
          });
          continue;
        }

        // Case-insensitive match on name
        if (name.toLowerCase() === queryLower) {
          matches.push({
            name,
            path: relPath,
            entityType,
            matchType: "case-insensitive",
            score: 0.9,
          });
          continue;
        }

        // Case-insensitive match on alias
        const aliasMatch = aliases.find(
          (a) => a.toLowerCase() === queryLower
        );
        if (aliasMatch) {
          matches.push({
            name,
            path: relPath,
            entityType,
            matchType: "alias",
            score: 0.85,
          });
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
    }

    // Sort by score descending
    matches.sort((a, b) => b.score - a.score);

    return JSON.stringify(
      {
        found: matches.length > 0,
        query,
        universe,
        matches: matches.slice(0, 10), // Cap at 10 results
      },
      null,
      2
    );
  },
});
