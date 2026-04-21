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
  related?: Record<string, string[]>;
  [key: string]: unknown;
}

interface OutgoingLink {
  target: string;
  resolved: boolean;
  path: string | null;
}

interface IncomingLink {
  source: string;
  sourceEntityType: string;
  path: string;
}

interface MissingBacklink {
  entity: string;
  shouldLinkTo: string;
  fixFile: string;
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

/** Extract all [[wikilinks]] from markdown content (body only, not frontmatter). */
function extractWikilinks(filePath: string): string[] {
  try {
    const content = readFileSync(filePath, "utf-8");
    const parsed = fm(content);
    const body = parsed.body;
    const regex = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
    const links: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = regex.exec(body)) !== null) {
      links.push(match[1].trim());
    }
    // Deduplicate
    return [...new Set(links)];
  } catch {
    return [];
  }
}

/**
 * Build a map of entity name -> file path for all entities in the KB.
 * Includes aliases as additional keys pointing to the same path.
 */
function buildEntityNameMap(
  cwd: string,
  dataPath: string
): Map<string, { path: string; name: string; entityType: string }> {
  const nameMap = new Map<
    string,
    { path: string; name: string; entityType: string }
  >();
  const entityTypes = getEntityTypeDirs(dataPath);

  for (const entityType of entityTypes) {
    const typeDir = join(dataPath, entityType);
    const files = readdirSync(typeDir).filter(
      (f) => f.endsWith(".md") && !f.startsWith("_")
    );

    for (const file of files) {
      const filePath = join(typeDir, file);
      const attrs = parseFrontmatter(filePath);
      const name = attrs?.name ?? basename(file, ".md");
      const relPath = relative(cwd, filePath).replace(/\\/g, "/");
      const entry = { path: relPath, name, entityType };

      // Index by canonical name
      nameMap.set(name.toLowerCase(), entry);

      // Index by aliases
      if (attrs?.aliases) {
        for (const alias of attrs.aliases) {
          nameMap.set(alias.toLowerCase(), entry);
        }
      }
    }
  }

  return nameMap;
}

// ---------------------------------------------------------------------------
// Tool: kb-backlinks
// ---------------------------------------------------------------------------

export default tool({
  description:
    "Check wikilink integrity in the knowledge base. For a single file, reports outgoing links, incoming links (backlinks), and missing backlinks. For check-all, scans every entity file and reports all broken links and missing backlinks across the entire KB. For find-orphans, returns entities with zero incoming links.",
  args: {
    universe: tool.schema
      .string()
      .describe("Universe slug (e.g. 'willverse')"),
    action: tool.schema
      .enum(["check", "check-all", "find-orphans"])
      .describe(
        "Action: 'check' for a single file, 'check-all' to scan the whole KB, 'find-orphans' to find entities with zero incoming links."
      ),
    file: tool.schema
      .string()
      .optional()
      .describe(
        "Relative path to a specific entity file (required for action='check'). e.g. 'kb/willverse/data/characters/Veylan.md'"
      ),
  },
  async execute(args, context) {
    const cwd = context.directory;
    const { universe, action, file } = args;
    const dataPath = resolveUniverseDataPath(cwd, universe);

    if (!existsSync(dataPath)) {
      return JSON.stringify({
        error: `No data/ directory found for universe '${universe}'.`,
      });
    }

    // Build the global entity name -> path map
    const nameMap = buildEntityNameMap(cwd, dataPath);

    // Collect all entity files.
    // IMPORTANT: _index.md and other _-prefixed files are excluded so that
    // auto-generated index table links are never counted as real backlinks.
    const allFiles: { name: string; entityType: string; absPath: string; relPath: string }[] = [];
    const entityTypes = getEntityTypeDirs(dataPath);
    for (const entityType of entityTypes) {
      const typeDir = join(dataPath, entityType);
      const files = readdirSync(typeDir).filter(
        (f) => f.endsWith(".md") && !f.startsWith("_")
      );
      for (const f of files) {
        const absPath = join(typeDir, f);
        const attrs = parseFrontmatter(absPath);
        allFiles.push({
          name: attrs?.name ?? basename(f, ".md"),
          entityType,
          absPath,
          relPath: relative(cwd, absPath).replace(/\\/g, "/"),
        });
      }
    }

    if (action === "check") {
      if (!file) {
        return JSON.stringify({
          error: "The 'file' parameter is required for action='check'.",
        });
      }

      const absFile = join(cwd, file);
      if (!existsSync(absFile)) {
        return JSON.stringify({
          error: `File not found: ${file}`,
        });
      }

      const attrs = parseFrontmatter(absFile);
      const entityName = attrs?.name ?? basename(file, ".md");
      const wikilinks = extractWikilinks(absFile);

      // Outgoing links
      const outgoing: OutgoingLink[] = wikilinks.map((target) => {
        const resolved = nameMap.get(target.toLowerCase());
        return {
          target,
          resolved: !!resolved,
          path: resolved?.path ?? null,
        };
      });

      // Incoming links (find all files that contain [[entityName]])
      const incoming: IncomingLink[] = [];
      for (const entry of allFiles) {
        if (entry.relPath === file) continue;
        const links = extractWikilinks(entry.absPath);
        if (
          links.some((l) => l.toLowerCase() === entityName.toLowerCase())
        ) {
          incoming.push({
            source: entry.name,
            sourceEntityType: entry.entityType,
            path: entry.relPath,
          });
        }
      }

      // Missing backlinks: entities we link TO that don't link BACK to us
      const missingBacklinks: MissingBacklink[] = [];
      for (const link of outgoing) {
        if (!link.resolved || !link.path) continue;
        const targetAbsPath = join(cwd, link.path);
        const targetLinks = extractWikilinks(targetAbsPath);
        const linksBackToUs = targetLinks.some(
          (l) => l.toLowerCase() === entityName.toLowerCase()
        );
        if (!linksBackToUs) {
          missingBacklinks.push({
            entity: link.target,
            shouldLinkTo: entityName,
            fixFile: link.path,
          });
        }
      }

      return JSON.stringify(
        {
          file,
          entity: entityName,
          outgoing,
          incoming,
          missingBacklinks,
          orphanLinks: outgoing.filter((o) => !o.resolved).map((o) => o.target),
        },
        null,
        2
      );
    }

    // -----------------------------------------------------------------------
    // action === "find-orphans"
    // Returns entities with zero incoming links from other entity files.
    // NOTE: _index.md files are excluded from scanning (files starting with
    // "_" are filtered out by getEntityTypeDirs and the file listing).
    // Links from _index.md tables do NOT count as incoming links.
    // -----------------------------------------------------------------------
    if (action === "find-orphans") {
      // Build incoming link counts for every entity
      const incomingCount = new Map<string, number>(); // relPath -> count
      for (const entry of allFiles) {
        incomingCount.set(entry.relPath, 0);
      }

      for (const entry of allFiles) {
        const wikilinks = extractWikilinks(entry.absPath);
        for (const target of wikilinks) {
          const resolved = nameMap.get(target.toLowerCase());
          if (resolved && resolved.path !== entry.relPath) {
            incomingCount.set(
              resolved.path,
              (incomingCount.get(resolved.path) ?? 0) + 1
            );
          }
        }
      }

      const orphans: {
        path: string;
        name: string;
        entityType: string;
        outgoingLinks: number;
        sources: string[];
      }[] = [];

      for (const entry of allFiles) {
        if ((incomingCount.get(entry.relPath) ?? 0) === 0) {
          const attrs = parseFrontmatter(entry.absPath);
          const outgoing = extractWikilinks(entry.absPath);
          orphans.push({
            path: entry.relPath,
            name: entry.name,
            entityType: entry.entityType,
            outgoingLinks: outgoing.length,
            sources: (attrs as Record<string, unknown>)?.sources as string[] ?? [],
          });
        }
      }

      return JSON.stringify(
        {
          action: "find-orphans",
          universe,
          totalFiles: allFiles.length,
          orphanCount: orphans.length,
          orphans,
          summary: `${orphans.length} orphaned entities out of ${allFiles.length} total (zero incoming links)`,
        },
        null,
        2
      );
    }

    // -----------------------------------------------------------------------
    // action === "check-all"
    // NOTE: Only entity .md files are scanned — _index.md and other files
    // starting with "_" are excluded. Links from auto-generated index tables
    // do NOT count as real backlinks.
    // -----------------------------------------------------------------------
    let totalLinks = 0;
    const brokenLinks: { file: string; target: string }[] = [];
    const allMissingBacklinks: MissingBacklink[] = [];

    for (const entry of allFiles) {
      const wikilinks = extractWikilinks(entry.absPath);
      totalLinks += wikilinks.length;

      for (const target of wikilinks) {
        const resolved = nameMap.get(target.toLowerCase());
        if (!resolved) {
          brokenLinks.push({
            file: entry.relPath,
            target,
          });
          continue;
        }

        // Check if target links back
        const targetAbsPath = join(cwd, resolved.path);
        const targetLinks = extractWikilinks(targetAbsPath);
        const linksBack = targetLinks.some(
          (l) => l.toLowerCase() === entry.name.toLowerCase()
        );
        if (!linksBack) {
          allMissingBacklinks.push({
            entity: target,
            shouldLinkTo: entry.name,
            fixFile: resolved.path,
          });
        }
      }
    }

    // Deduplicate missing backlinks (A->B missing and B->A missing are two entries, that's fine)
    const deduped = allMissingBacklinks.filter(
      (item, idx, arr) =>
        arr.findIndex(
          (x) =>
            x.entity === item.entity &&
            x.shouldLinkTo === item.shouldLinkTo
        ) === idx
    );

    return JSON.stringify(
      {
        action: "check-all",
        universe,
        totalFiles: allFiles.length,
        totalLinks,
        brokenLinks,
        missingBacklinks: deduped,
        summary: `${allFiles.length} files, ${totalLinks} links, ${brokenLinks.length} broken, ${deduped.length} missing backlinks`,
      },
      null,
      2
    );
  },
});
