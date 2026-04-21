import { tool } from "@opencode-ai/plugin";
import * as fmModule from "front-matter";
const fm = fmModule.default as unknown as <T>(s: string) => { attributes: T; body: string; bodyBegin: number; frontmatter?: string };
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join, basename, dirname, relative } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface KbaasConfig {
  databasePath?: string;
  kbPath?: string;
}

interface EntityTypeConfig {
  name: string;
  description: string;
  requiredEntities: string[];
  [key: string]: unknown;
}

interface EntitiesConfig {
  schema?: string;
  value: EntityTypeConfig[];
}

interface EntityFrontmatter {
  entityType: string;
  name: string;
  aliases: string[];
  sources: string[];
  related: Record<string, string[]>;
  created: string;
  updated: string;
  [key: string]: unknown;
}

interface IndexFrontmatter {
  type: "index";
  entityType: string;
  count: number;
  updated: string;
  [key: string]: unknown;
}

interface ValidationError {
  field: string;
  message: string;
  severity: "error" | "warning";
}

interface VerifyResult {
  file: string;
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationError[];
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

function resolveUniversePath(cwd: string, universe: string): string {
  const kbPath = resolveKbPath(cwd);
  return join(cwd, kbPath, universe);
}

function loadEntitiesConfig(
  cwd: string,
  universe: string
): EntitiesConfig | null {
  const metaPath = join(resolveUniversePath(cwd, universe), "_meta", "entities.json");
  if (!existsSync(metaPath)) return null;
  try {
    return JSON.parse(readFileSync(metaPath, "utf-8"));
  } catch {
    return null;
  }
}

function getValidEntityTypes(config: EntitiesConfig): string[] {
  return config.value.map((t) => t.name);
}

function getRequiredEntities(
  config: EntitiesConfig,
  entityType: string
): string[] {
  const typeConfig = config.value.find((t) => t.name === entityType);
  return typeConfig?.requiredEntities ?? [];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const WIKILINK_RE = /^\[\[[^\]]+\]\]$/;

function isValidDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !isNaN(d.getTime());
}

function isArray(v: unknown): v is unknown[] {
  return Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return isArray(v) && v.every((x) => typeof x === "string");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Validation — Entity Files
// ---------------------------------------------------------------------------

function validateEntityFrontmatter(
  attrs: Record<string, unknown>,
  filePath: string,
  config: EntitiesConfig
): ValidationError[] {
  const errors: ValidationError[] = [];
  const validTypes = getValidEntityTypes(config);

  // Required fields
  const requiredFields = [
    "entityType",
    "name",
    "aliases",
    "sources",
    "related",
    "created",
    "updated",
  ];
  for (const field of requiredFields) {
    if (attrs[field] === undefined || attrs[field] === null) {
      errors.push({
        field,
        message: `Missing required field '${field}'`,
        severity: "error",
      });
    }
  }

  // entityType: must be a string matching a configured type
  if (typeof attrs.entityType === "string") {
    if (!validTypes.includes(attrs.entityType)) {
      errors.push({
        field: "entityType",
        message: `Invalid entityType '${attrs.entityType}'. Must be one of: ${validTypes.join(", ")}`,
        severity: "error",
      });
    }
    // Must match parent directory name
    const parentDir = basename(dirname(filePath));
    if (parentDir !== attrs.entityType) {
      errors.push({
        field: "entityType",
        message: `entityType '${attrs.entityType}' does not match parent directory '${parentDir}'`,
        severity: "error",
      });
    }
  } else if (attrs.entityType !== undefined) {
    errors.push({
      field: "entityType",
      message: `entityType must be a string, got ${typeof attrs.entityType}`,
      severity: "error",
    });
  }

  // name: must be a non-empty string
  if (typeof attrs.name === "string") {
    if (attrs.name.trim().length === 0) {
      errors.push({
        field: "name",
        message: "name must not be empty",
        severity: "error",
      });
    }
    // Should match filename
    const expectedFilename = attrs.name + ".md";
    const actualFilename = basename(filePath);
    if (actualFilename !== expectedFilename) {
      errors.push({
        field: "name",
        message: `name '${attrs.name}' does not match filename '${actualFilename}' (expected '${expectedFilename}')`,
        severity: "warning",
      });
    }
  } else if (attrs.name !== undefined) {
    errors.push({
      field: "name",
      message: `name must be a string, got ${typeof attrs.name}`,
      severity: "error",
    });
  }

  // aliases: must be a string array
  if (attrs.aliases !== undefined) {
    if (!isStringArray(attrs.aliases)) {
      errors.push({
        field: "aliases",
        message: "aliases must be an array of strings",
        severity: "error",
      });
    }
  }

  // sources: must be a non-empty string array
  if (attrs.sources !== undefined) {
    if (!isStringArray(attrs.sources)) {
      errors.push({
        field: "sources",
        message: "sources must be an array of strings",
        severity: "error",
      });
    } else if (attrs.sources.length === 0) {
      errors.push({
        field: "sources",
        message: "sources must contain at least one entry",
        severity: "error",
      });
    }
  }

  // related: must be Record<string, string[]> with valid keys and wikilink values
  if (attrs.related !== undefined) {
    // Auto-coerce: if related is missing, null, or not an object, default to {}
    if (!isRecord(attrs.related)) {
      attrs.related = {};
      errors.push({
        field: "related",
        message: "related was not an object — coerced to empty {}",
        severity: "warning",
      });
    }
    {
      for (const [key, val] of Object.entries(attrs.related as Record<string, unknown>)) {
        if (!validTypes.includes(key)) {
          errors.push({
            field: `related.${key}`,
            message: `Unknown entity type key '${key}' in related. Must be one of: ${validTypes.join(", ")}`,
            severity: "error",
          });
        }
        if (!isStringArray(val)) {
          errors.push({
            field: `related.${key}`,
            message: `related.${key} must be an array of strings`,
            severity: "error",
          });
        } else {
          for (const link of val) {
            if (!WIKILINK_RE.test(link)) {
              errors.push({
                field: `related.${key}`,
                message: `Value '${link}' in related.${key} must be a wikilink (e.g. '[[Entity Name]]')`,
                severity: "error",
              });
            }
          }
          // Check for duplicates
          const unique = new Set(val);
          if (unique.size !== val.length) {
            errors.push({
              field: `related.${key}`,
              message: `Duplicate entries in related.${key}`,
              severity: "warning",
            });
          }
        }
      }

      // Check requiredEntities
      if (typeof attrs.entityType === "string" && validTypes.includes(attrs.entityType)) {
        const required = getRequiredEntities(config, attrs.entityType);
        for (const req of required) {
          const relEntries = (attrs.related as Record<string, string[]>)[req];
          if (!relEntries || relEntries.length === 0) {
            errors.push({
              field: `related.${req}`,
              message: `Entity type '${attrs.entityType}' requires at least one cross-reference to '${req}' (per _meta/entities.json requiredEntities)`,
              severity: "warning",
            });
          }
        }
      }
    }
  }

  // created / updated: must be valid YYYY-MM-DD
  for (const dateField of ["created", "updated"] as const) {
    if (typeof attrs[dateField] === "string") {
      if (!isValidDate(attrs[dateField] as string)) {
        errors.push({
          field: dateField,
          message: `${dateField} must be a valid date in YYYY-MM-DD format, got '${attrs[dateField]}'`,
          severity: "error",
        });
      }
    } else if (attrs[dateField] !== undefined) {
      // YAML may parse dates as Date objects — coerce them
      if (attrs[dateField] instanceof Date) {
        // This is acceptable but we'll note it as a warning
        errors.push({
          field: dateField,
          message: `${dateField} was parsed as a Date object — quote it in YAML (e.g. "${dateField}: \\"2026-01-01\\"") to prevent auto-parsing`,
          severity: "warning",
        });
      } else {
        errors.push({
          field: dateField,
          message: `${dateField} must be a string in YYYY-MM-DD format`,
          severity: "error",
        });
      }
    }
  }

  // updated >= created
  if (
    typeof attrs.created === "string" &&
    typeof attrs.updated === "string" &&
    isValidDate(attrs.created) &&
    isValidDate(attrs.updated)
  ) {
    if (attrs.updated < attrs.created) {
      errors.push({
        field: "updated",
        message: `updated date (${attrs.updated}) is before created date (${attrs.created})`,
        severity: "warning",
      });
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Validation — Body Structure
// ---------------------------------------------------------------------------

function validateEntityBody(body: string): ValidationError[] {
  const errors: ValidationError[] = [];
  const requiredSections = ["## Overview", "## Evidence", "## Relationships"];

  for (const section of requiredSections) {
    if (!body.includes(section)) {
      errors.push({
        field: "body",
        message: `Missing required section '${section}'`,
        severity: "error",
      });
    }
  }

  // Check that there's an H1 heading
  if (!/^# .+/m.test(body)) {
    errors.push({
      field: "body",
      message: "Missing H1 heading (# Entity Name)",
      severity: "error",
    });
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Validation — Index Files
// ---------------------------------------------------------------------------

function validateIndexFrontmatter(
  attrs: Record<string, unknown>,
  config: EntitiesConfig
): ValidationError[] {
  const errors: ValidationError[] = [];
  const validTypes = getValidEntityTypes(config);

  // type: must be "index"
  if (attrs.type !== "index") {
    errors.push({
      field: "type",
      message: `type must be 'index', got '${attrs.type}'`,
      severity: "error",
    });
  }

  // entityType
  if (typeof attrs.entityType === "string") {
    if (!validTypes.includes(attrs.entityType)) {
      errors.push({
        field: "entityType",
        message: `Invalid entityType '${attrs.entityType}'`,
        severity: "error",
      });
    }
  } else {
    errors.push({
      field: "entityType",
      message: "Missing or invalid entityType",
      severity: "error",
    });
  }

  // count
  if (typeof attrs.count !== "number" || !Number.isInteger(attrs.count)) {
    errors.push({
      field: "count",
      message: "count must be an integer",
      severity: "error",
    });
  }

  // updated
  if (typeof attrs.updated === "string") {
    if (!isValidDate(attrs.updated)) {
      errors.push({
        field: "updated",
        message: `updated must be a valid YYYY-MM-DD date`,
        severity: "error",
      });
    }
  } else if (attrs.updated instanceof Date) {
    errors.push({
      field: "updated",
      message: "updated was parsed as a Date object — quote it in YAML",
      severity: "warning",
    });
  } else {
    errors.push({
      field: "updated",
      message: "Missing or invalid updated field",
      severity: "error",
    });
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Full file validation
// ---------------------------------------------------------------------------

function verifyFile(
  filePath: string,
  config: EntitiesConfig
): VerifyResult {
  const result: VerifyResult = {
    file: filePath,
    valid: true,
    errors: [],
    warnings: [],
  };

  if (!existsSync(filePath)) {
    result.valid = false;
    result.errors.push({
      field: "file",
      message: `File does not exist: ${filePath}`,
      severity: "error",
    });
    return result;
  }

  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch (e) {
    result.valid = false;
    result.errors.push({
      field: "file",
      message: `Cannot read file: ${e}`,
      severity: "error",
    });
    return result;
  }

  // Parse frontmatter
  let parsed: { attributes: Record<string, unknown>; body: string };
  try {
    parsed = fm<Record<string, unknown>>(content);
  } catch (e) {
    result.valid = false;
    result.errors.push({
      field: "frontmatter",
      message: `Malformed YAML frontmatter: ${e}`,
      severity: "error",
    });
    return result;
  }

  const isIndex = basename(filePath) === "_index.md";

  let validationErrors: ValidationError[];
  if (isIndex) {
    validationErrors = validateIndexFrontmatter(parsed.attributes, config);
  } else {
    validationErrors = [
      ...validateEntityFrontmatter(parsed.attributes, filePath, config),
      ...validateEntityBody(parsed.body),
    ];
  }

  for (const err of validationErrors) {
    if (err.severity === "error") {
      result.errors.push(err);
      result.valid = false;
    } else {
      result.warnings.push(err);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Helpers — YAML and Markdown generation for upsert
// ---------------------------------------------------------------------------

function buildRelatedYaml(related: Record<string, string[]>): string {
  const entries = Object.entries(related).filter(([, v]) => v.length > 0);
  if (entries.length === 0) return "related: {}";
  const lines = ["related:"];
  for (const [key, vals] of entries) {
    lines.push(`  ${key}:`);
    for (const v of vals) {
      lines.push(`    - "${v}"`);
    }
  }
  return lines.join("\n");
}

function buildRelationshipLines(related: Record<string, string[]>): string {
  const lines: string[] = [];
  for (const [type, vals] of Object.entries(related)) {
    for (const v of vals) {
      lines.push(`- ${type}: ${v}`);
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Helper — Rewrite wikilinks across the entire KB
// ---------------------------------------------------------------------------

/**
 * Scans all entity files in the KB and replaces wikilinks and related[]
 * references from `oldNames` to `newName`. Returns count of files modified.
 * Skips _index.md files. Only processes entity .md files.
 */
function rewriteReferencesAcrossKb(
  cwd: string,
  dataPath: string,
  oldNames: string[],
  newName: string,
  skipFile?: string
): { filesModified: number; rewriteDetails: string[] } {
  let filesModified = 0;
  const details: string[] = [];
  const entityTypes = getEntityTypeDirsFromPath(dataPath);

  // Build regex that matches any of the old names as wikilinks
  // Escape regex special chars in names
  const escapedNames = oldNames.map((n) =>
    n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  );
  // Match [[OldName]] or [[OldName|display text]]
  const linkRegex = new RegExp(
    `\\[\\[(${escapedNames.join("|")})(\\|[^\\]]*)?\\]\\]`,
    "gi"
  );

  for (const entityType of entityTypes) {
    const typeDir = join(dataPath, entityType);
    if (!existsSync(typeDir)) continue;
    const files = readdirSync(typeDir).filter(
      (f) => f.endsWith(".md") && !f.startsWith("_")
    );

    for (const file of files) {
      const filePath = join(typeDir, file);
      const fileRelPath = relative(cwd, filePath).replace(/\\/g, "/");

      // Don't modify the file we're about to delete
      if (skipFile && fileRelPath === skipFile) continue;

      let content: string;
      try {
        content = readFileSync(filePath, "utf-8");
      } catch {
        continue;
      }

      let modified = false;
      let newContent = content;

      // 1. Rewrite wikilinks in the body
      const parsed = fm<Record<string, unknown>>(newContent);
      const bodyStart = parsed.bodyBegin;
      const frontmatterPart = newContent.slice(0, bodyStart);
      let bodyPart = newContent.slice(bodyStart);

      const newBody = bodyPart.replace(linkRegex, (_match, _name, pipePart) => {
        modified = true;
        // Preserve pipe alias if present
        return pipePart ? `[[${newName}${pipePart}]]` : `[[${newName}]]`;
      });
      if (newBody !== bodyPart) {
        bodyPart = newBody;
      }

      // 2. Rewrite related[] entries in frontmatter
      // Parse frontmatter, fix related arrays, rebuild
      try {
        const fmParsed = fm<EntityFrontmatter>(newContent);
        const attrs = fmParsed.attributes;
        if (attrs.related && isRecord(attrs.related)) {
          let relatedModified = false;
          const relatedObj = attrs.related as Record<string, string[]>;
          for (const [key, vals] of Object.entries(relatedObj)) {
            if (!isStringArray(vals)) continue;
            const newVals = vals.map((v) => {
              // Check if this wikilink matches any old name
              const innerMatch = v.match(/^\[\[([^\]|]+)(?:\|[^\]]+)?\]\]$/);
              if (innerMatch) {
                const innerName = innerMatch[1].trim();
                if (oldNames.some((old) => old.toLowerCase() === innerName.toLowerCase())) {
                  relatedModified = true;
                  return `[[${newName}]]`;
                }
              }
              return v;
            });
            // Deduplicate after rewriting (two old names might map to same new name)
            relatedObj[key] = [...new Set(newVals)];
          }
          if (relatedModified) {
            modified = true;
            // Rebuild the frontmatter with updated related
            const relatedYaml = buildRelatedYaml(relatedObj);
            // Replace the related block in frontmatter
            // We need to rebuild the entire frontmatter section
            const aliasesYaml = isStringArray(attrs.aliases) && attrs.aliases.length > 0
              ? attrs.aliases.map((a) => `  - "${a}"`).join("\n")
              : "";
            const sourcesYaml = isStringArray(attrs.sources)
              ? attrs.sources.map((s) => `  - "${s}"`).join("\n")
              : "";
            const created = typeof attrs.created === "string" ? attrs.created
              : (attrs.created instanceof Date ? (attrs.created as Date).toISOString().slice(0, 10)
              : new Date().toISOString().slice(0, 10));
            const updated = new Date().toISOString().slice(0, 10);

            const newFrontmatter = [
              "---",
              `entityType: ${attrs.entityType}`,
              `name: "${attrs.name}"`,
              `aliases:${aliasesYaml ? "\n" + aliasesYaml : " []"}`,
              `sources:\n${sourcesYaml}`,
              relatedYaml,
              `created: "${created}"`,
              `updated: "${updated}"`,
              "---",
            ].join("\n");

            newContent = newFrontmatter + "\n" + bodyPart;
          } else {
            newContent = frontmatterPart + bodyPart;
          }
        } else {
          newContent = frontmatterPart + bodyPart;
        }
      } catch {
        // If frontmatter parsing fails, just do body replacement
        newContent = frontmatterPart + bodyPart;
      }

      if (modified) {
        try {
          writeFileSync(filePath, newContent, "utf-8");
          filesModified++;
          details.push(`Rewrote references in ${fileRelPath}`);
        } catch {
          details.push(`Failed to write ${fileRelPath}`);
        }
      }
    }
  }

  return { filesModified, rewriteDetails: details };
}

/** Get entity type directories from a data path (excludes _-prefixed dirs) */
function getEntityTypeDirsFromPath(dataPath: string): string[] {
  if (!existsSync(dataPath)) return [];
  return readdirSync(dataPath, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("_") && !d.name.startsWith("."))
    .map((d) => d.name);
}

// ---------------------------------------------------------------------------
// Tool: kb-update
// ---------------------------------------------------------------------------

export default tool({
  description:
    "Write or verify knowledge base entity files with built-in validation. " +
    "Actions: 'write-entity' validates frontmatter + body structure then writes an entity .md file; " +
    "'upsert-entity' merges new evidence/sources/relationships into an existing entity (or creates if new) — " +
    "pass structured JSON instead of full markdown; " +
    "'write-index' validates index frontmatter then writes an _index.md file; " +
    "'verify' validates an existing file, type folder, or entire KB without writing. " +
    "'merge-entities' merges two entity files into one (keeping the richer target), rewrites all references across the KB, and optionally deletes the source file; " +
    "'delete-entity' removes an entity file and cleans up all references to it across the KB. " +
    "This tool reads _meta/entities.json at runtime to enforce universe-specific rules. " +
    "All writes go through validation — invalid content is rejected with detailed error messages.",
  args: {
    universe: tool.schema
      .string()
      .describe("Universe slug (e.g. 'willverse')"),
    action: tool.schema
      .enum(["write-entity", "upsert-entity", "write-index", "verify", "merge-entities", "delete-entity"])
      .describe(
        "Action: 'write-entity' to create/update an entity file with full markdown, " +
        "'upsert-entity' to merge new evidence into existing entity (or create if new) using structured JSON, " +
        "'write-index' for _index.md, 'verify' for read-only validation, " +
        "'merge-entities' to merge source entity into target entity and rewrite all references, " +
        "'delete-entity' to remove an entity file and clean up references"
      ),
    path: tool.schema
      .string()
      .optional()
      .describe(
        "Relative file path for write/delete actions (e.g. 'kb/<slug>/data/characters/Entity Name.md'). " +
        "For verify: a specific file, or a type folder (e.g. 'kb/<slug>/data/characters/'), or omit to verify the whole KB. " +
        "For delete-entity: the entity file to remove."
      ),
    content: tool.schema
      .string()
      .optional()
      .describe(
        "Full markdown content to write (required for write-entity and write-index). " +
        "Must include YAML frontmatter delimited by --- and the markdown body."
      ),
    upsertData: tool.schema
      .string()
      .optional()
      .describe(
        "JSON string for upsert-entity action. Fields: " +
        "{\"entityType\": \"characters\", \"name\": \"Wei Shi Lindon\", " +
        "\"aliases\": [\"Lindon\"], " +
        "\"newSource\": \"chapter-4.md\", " +
        "\"newEvidence\": \"> quote from chapter 4\", " +
        "\"newRelated\": {\"locations\": [\"[[Sacred Valley]]\"]}, " +
        "\"overviewAddition\": \"Additional context to incorporate into the overview.\"}. " +
        "The tool handles reading existing file, merging, and writing."
      ),
    sourcePath: tool.schema
      .string()
      .optional()
      .describe(
        "For merge-entities: relative path to the SOURCE entity file (the one being merged FROM and optionally deleted). " +
        "e.g. 'kb/willverse/data/events/The Seven-Year Festival.md'"
      ),
    targetPath: tool.schema
      .string()
      .optional()
      .describe(
        "For merge-entities: relative path to the TARGET entity file (the one being merged INTO — the survivor). " +
        "e.g. 'kb/willverse/data/events/Seven-Year Festival.md'"
      ),
    deleteSource: tool.schema
      .boolean()
      .optional()
      .describe(
        "For merge-entities: whether to delete the source file after merging (default: true)."
      ),
  },
  async execute(args, context) {
    const cwd = context.directory;
    const { universe, action, path: relPath, content } = args;

    // Load entity config
    const config = loadEntitiesConfig(cwd, universe);
    if (!config) {
      return JSON.stringify({
        success: false,
        error: `Cannot load entity configuration from kb/${universe}/_meta/entities.json. File may not exist or is malformed.`,
      });
    }

    // -----------------------------------------------------------------------
    // VERIFY action
    // -----------------------------------------------------------------------
    if (action === "verify") {
      const universePath = resolveUniversePath(cwd, universe);
      const dataPath = join(universePath, "data");

      // No path = verify entire KB
      if (!relPath) {
        if (!existsSync(dataPath)) {
          return JSON.stringify({
            success: true,
            action: "verify",
            scope: "all",
            message: `No data/ directory for universe '${universe}'. Nothing to verify.`,
            results: [],
          });
        }

        const results: VerifyResult[] = [];
        const entityTypes = readdirSync(dataPath, { withFileTypes: true })
          .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
          .map((d) => d.name);

        for (const entityType of entityTypes) {
          const typeDir = join(dataPath, entityType);
          const files = readdirSync(typeDir).filter((f) => f.endsWith(".md"));
          for (const file of files) {
            results.push(verifyFile(join(typeDir, file), config));
          }
        }

        const totalErrors = results.reduce((s, r) => s + r.errors.length, 0);
        const totalWarnings = results.reduce((s, r) => s + r.warnings.length, 0);
        const invalidCount = results.filter((r) => !r.valid).length;

        return JSON.stringify(
          {
            success: true,
            action: "verify",
            scope: "all",
            universe,
            filesChecked: results.length,
            filesInvalid: invalidCount,
            totalErrors,
            totalWarnings,
            results: results.filter((r) => !r.valid || r.warnings.length > 0),
          },
          null,
          2
        );
      }

      // Path is a directory = verify all files in that folder
      const absPath = join(cwd, relPath);
      if (existsSync(absPath) && statSync(absPath).isDirectory()) {
        const files = readdirSync(absPath).filter((f) => f.endsWith(".md"));
        const results: VerifyResult[] = files.map((f) =>
          verifyFile(join(absPath, f), config)
        );
        const totalErrors = results.reduce((s, r) => s + r.errors.length, 0);
        const totalWarnings = results.reduce((s, r) => s + r.warnings.length, 0);

        return JSON.stringify(
          {
            success: true,
            action: "verify",
            scope: "folder",
            path: relPath,
            filesChecked: results.length,
            filesInvalid: results.filter((r) => !r.valid).length,
            totalErrors,
            totalWarnings,
            results: results.filter((r) => !r.valid || r.warnings.length > 0),
          },
          null,
          2
        );
      }

      // Path is a single file
      const result = verifyFile(absPath, config);
      return JSON.stringify(
        {
          success: true,
          action: "verify",
          ...result,
        },
        null,
        2
      );
    }

    // -----------------------------------------------------------------------
    // UPSERT-ENTITY action — structured merge (the efficient path)
    // -----------------------------------------------------------------------
    if (action === "upsert-entity") {
      if (!args.upsertData) {
        return JSON.stringify({
          success: false,
          error: "The 'upsertData' parameter is required for upsert-entity action.",
        });
      }

      let upsert: {
        entityType: string;
        name: string;
        aliases?: string[];
        newSource: string;
        newEvidence: string;
        newRelated?: Record<string, string[]>;
        overviewAddition?: string;
      };
      try {
        upsert = JSON.parse(args.upsertData);
      } catch (e) {
        return JSON.stringify({ success: false, error: `Failed to parse upsertData JSON: ${e}` });
      }

      // Validate required upsert fields
      if (!upsert.entityType || !upsert.name || !upsert.newSource || !upsert.newEvidence) {
        return JSON.stringify({
          success: false,
          error: "upsertData must include entityType, name, newSource, and newEvidence.",
        });
      }

      const validTypes = getValidEntityTypes(config);
      if (!validTypes.includes(upsert.entityType)) {
        return JSON.stringify({
          success: false,
          error: `Invalid entityType '${upsert.entityType}'. Must be one of: ${validTypes.join(", ")}`,
        });
      }

      // Derive path deterministically
      const kbPath = resolveKbPath(cwd);
      const derivedRelPath = `${kbPath}${universe}/data/${upsert.entityType}/${upsert.name}.md`;
      const absPath = join(cwd, derivedRelPath);
      const today = new Date().toISOString().slice(0, 10);
      const isNew = !existsSync(absPath);

      let finalContent: string;

      if (isNew) {
        // CREATE new entity file
        const relatedYaml = buildRelatedYaml(upsert.newRelated || {});
        const aliasesYaml = (upsert.aliases && upsert.aliases.length > 0)
          ? upsert.aliases.map((a) => `  - "${a}"`).join("\n")
          : "";

        const overviewText = upsert.overviewAddition || `Entity referenced in ${upsert.newSource}.`;
        const relationshipLines = buildRelationshipLines(upsert.newRelated || {});

        finalContent = [
          "---",
          `entityType: ${upsert.entityType}`,
          `name: "${upsert.name}"`,
          `aliases:${aliasesYaml ? "\n" + aliasesYaml : " []"}`,
          `sources:\n  - "${upsert.newSource}"`,
          relatedYaml,
          `created: "${today}"`,
          `updated: "${today}"`,
          "---",
          "",
          `# ${upsert.name}`,
          "",
          "## Overview",
          "",
          overviewText,
          "",
          "## Evidence",
          "",
          `### From ${upsert.newSource}`,
          upsert.newEvidence,
          "",
          "## Relationships",
          "",
          relationshipLines || `No relationships documented yet.`,
          "",
        ].join("\n");
      } else {
        // UPDATE existing entity file — merge in new data
        let existingContent: string;
        try {
          existingContent = readFileSync(absPath, "utf-8");
        } catch (e) {
          return JSON.stringify({ success: false, error: `Failed to read existing file: ${e}` });
        }

        let existingParsed: { attributes: Record<string, unknown>; body: string };
        try {
          existingParsed = fm<Record<string, unknown>>(existingContent);
        } catch (e) {
          return JSON.stringify({ success: false, error: `Failed to parse existing frontmatter: ${e}` });
        }

        const attrs = existingParsed.attributes as EntityFrontmatter;

        // Merge sources (deduplicate)
        const sources = Array.isArray(attrs.sources) ? [...attrs.sources] : [];
        if (!sources.includes(upsert.newSource)) {
          sources.push(upsert.newSource);
        }

        // Merge aliases (deduplicate)
        const aliases = Array.isArray(attrs.aliases) ? [...attrs.aliases] : [];
        if (upsert.aliases) {
          for (const alias of upsert.aliases) {
            if (!aliases.includes(alias) && alias !== upsert.name) {
              aliases.push(alias);
            }
          }
        }

        // Merge related (union, deduplicate)
        const existingRelated: Record<string, string[]> = isRecord(attrs.related)
          ? { ...attrs.related } as Record<string, string[]>
          : {};
        if (upsert.newRelated) {
          for (const [key, vals] of Object.entries(upsert.newRelated)) {
            if (!existingRelated[key]) {
              existingRelated[key] = [];
            }
            for (const v of vals) {
              if (!existingRelated[key].includes(v)) {
                existingRelated[key].push(v);
              }
            }
          }
        }

        // Build updated body
        let body = existingParsed.body;

        // Append evidence section
        const evidenceSection = `### From ${upsert.newSource}\n${upsert.newEvidence}`;
        const evidenceMarker = "## Evidence";
        const relationshipsMarker = "## Relationships";

        const evidenceIdx = body.indexOf(evidenceMarker);
        const relIdx = body.indexOf(relationshipsMarker);

        if (evidenceIdx >= 0 && relIdx >= 0) {
          // Insert new evidence before ## Relationships
          const beforeRel = body.slice(0, relIdx).trimEnd();
          const afterRel = body.slice(relIdx);
          body = beforeRel + "\n\n" + evidenceSection + "\n\n" + afterRel;
        } else if (evidenceIdx >= 0) {
          // No relationships section — append at end of evidence
          body = body.trimEnd() + "\n\n" + evidenceSection + "\n";
        } else {
          // No evidence section at all — append both
          body = body.trimEnd() + "\n\n## Evidence\n\n" + evidenceSection + "\n";
        }

        // Update overview if overviewAddition provided
        if (upsert.overviewAddition) {
          const overviewIdx = body.indexOf("## Overview");
          const nextSectionIdx = body.indexOf("## Evidence");
          if (overviewIdx >= 0 && nextSectionIdx >= 0) {
            const overviewContent = body.slice(overviewIdx + "## Overview".length, nextSectionIdx).trim();
            const updatedOverview = overviewContent + " " + upsert.overviewAddition;
            body = body.slice(0, overviewIdx) + "## Overview\n\n" + updatedOverview + "\n\n" + body.slice(nextSectionIdx);
          }
        }

        // Update relationships section with merged related
        if (upsert.newRelated && Object.keys(upsert.newRelated).length > 0) {
          const newRelLines = buildRelationshipLines(existingRelated);
          const relMarkerIdx = body.indexOf(relationshipsMarker);
          if (relMarkerIdx >= 0) {
            // Find next section or end
            const afterRelStart = relMarkerIdx + relationshipsMarker.length;
            const nextH2 = body.indexOf("\n## ", afterRelStart);
            const relEnd = nextH2 >= 0 ? nextH2 : body.length;
            body = body.slice(0, relMarkerIdx) + "## Relationships\n\n" + newRelLines + "\n" + body.slice(relEnd);
          }
        }

        // Rebuild frontmatter
        const relatedYaml = buildRelatedYaml(existingRelated);
        const aliasesYaml = aliases.length > 0
          ? aliases.map((a) => `  - "${a}"`).join("\n")
          : "";
        const sourcesYaml = sources.map((s) => `  - "${s}"`).join("\n");

        const created = typeof attrs.created === "string" ? attrs.created
          : ((attrs.created as unknown) instanceof Date ? ((attrs.created as unknown) as Date).toISOString().slice(0, 10) : today);

        finalContent = [
          "---",
          `entityType: ${upsert.entityType}`,
          `name: "${upsert.name}"`,
          `aliases:${aliasesYaml ? "\n" + aliasesYaml : " []"}`,
          `sources:\n${sourcesYaml}`,
          relatedYaml,
          `created: "${created}"`,
          `updated: "${today}"`,
          "---",
          body,
        ].join("\n");
      }

      // Validate the final content before writing
      let finalParsed: { attributes: Record<string, unknown>; body: string };
      try {
        finalParsed = fm<Record<string, unknown>>(finalContent);
      } catch (e) {
        return JSON.stringify({ success: false, error: `Generated content has malformed frontmatter: ${e}` });
      }

      const validationErrors = [
        ...validateEntityFrontmatter(finalParsed.attributes, absPath, config),
        ...validateEntityBody(finalParsed.body),
      ];
      const hardErrors = validationErrors.filter((e) => e.severity === "error");
      const warnings = validationErrors.filter((e) => e.severity === "warning");

      if (hardErrors.length > 0) {
        return JSON.stringify(
          {
            success: false,
            action: "upsert-entity",
            path: derivedRelPath,
            error: "Validation failed on generated content.",
            errors: hardErrors,
            warnings,
          },
          null,
          2
        );
      }

      // Ensure parent directory exists
      const parentDir = dirname(absPath);
      if (!existsSync(parentDir)) {
        mkdirSync(parentDir, { recursive: true });
      }

      try {
        writeFileSync(absPath, finalContent, "utf-8");
      } catch (e) {
        return JSON.stringify({ success: false, error: `Failed to write file: ${e}` });
      }

      return JSON.stringify(
        {
          success: true,
          action: "upsert-entity",
          path: derivedRelPath,
          operation: isNew ? "created" : "updated",
          warnings: warnings.length > 0 ? warnings : undefined,
          message: `${isNew ? "Created" : "Updated"} ${derivedRelPath} successfully.`,
        },
        null,
        2
      );
    }

    // -----------------------------------------------------------------------
    // MERGE-ENTITIES action — merges source entity into target, rewrites refs
    // -----------------------------------------------------------------------
    if (action === "merge-entities") {
      const { sourcePath, targetPath, deleteSource: shouldDelete } = args;

      if (!sourcePath || !targetPath) {
        return JSON.stringify({
          success: false,
          error: "Both 'sourcePath' and 'targetPath' are required for merge-entities action.",
        });
      }

      const absSource = join(cwd, sourcePath);
      const absTarget = join(cwd, targetPath);

      if (!existsSync(absSource)) {
        return JSON.stringify({ success: false, error: `Source file not found: ${sourcePath}` });
      }
      if (!existsSync(absTarget)) {
        return JSON.stringify({ success: false, error: `Target file not found: ${targetPath}` });
      }

      // Parse both files
      let sourceContent: string, targetContent: string;
      try {
        sourceContent = readFileSync(absSource, "utf-8");
        targetContent = readFileSync(absTarget, "utf-8");
      } catch (e) {
        return JSON.stringify({ success: false, error: `Failed to read files: ${e}` });
      }

      let sourceParsed: { attributes: Record<string, unknown>; body: string };
      let targetParsed: { attributes: Record<string, unknown>; body: string };
      try {
        sourceParsed = fm<Record<string, unknown>>(sourceContent);
        targetParsed = fm<Record<string, unknown>>(targetContent);
      } catch (e) {
        return JSON.stringify({ success: false, error: `Failed to parse frontmatter: ${e}` });
      }

      const srcAttrs = sourceParsed.attributes as EntityFrontmatter;
      const tgtAttrs = targetParsed.attributes as EntityFrontmatter;
      const today = new Date().toISOString().slice(0, 10);

      // --- Merge aliases ---
      // Target keeps its name; source name + source aliases become target aliases
      const mergedAliases = new Set<string>(
        isStringArray(tgtAttrs.aliases) ? tgtAttrs.aliases : []
      );
      // Add source name as alias (if different from target name)
      if (srcAttrs.name && srcAttrs.name.toLowerCase() !== tgtAttrs.name.toLowerCase()) {
        mergedAliases.add(srcAttrs.name);
      }
      // Add source aliases
      if (isStringArray(srcAttrs.aliases)) {
        for (const alias of srcAttrs.aliases) {
          if (alias.toLowerCase() !== tgtAttrs.name.toLowerCase()) {
            mergedAliases.add(alias);
          }
        }
      }
      const finalAliases = [...mergedAliases];

      // --- Merge sources ---
      const mergedSources = new Set<string>(
        isStringArray(tgtAttrs.sources) ? tgtAttrs.sources : []
      );
      if (isStringArray(srcAttrs.sources)) {
        for (const s of srcAttrs.sources) mergedSources.add(s);
      }
      const finalSources = [...mergedSources];

      // --- Merge related ---
      const tgtRelated: Record<string, string[]> = isRecord(tgtAttrs.related)
        ? JSON.parse(JSON.stringify(tgtAttrs.related))
        : {};
      const srcRelated: Record<string, string[]> = isRecord(srcAttrs.related)
        ? (srcAttrs.related as Record<string, string[]>)
        : {};

      for (const [key, vals] of Object.entries(srcRelated)) {
        if (!isStringArray(vals)) continue;
        if (!tgtRelated[key]) tgtRelated[key] = [];
        for (const v of vals) {
          // Don't add self-references (source linking to target or vice versa)
          const innerMatch = v.match(/^\[\[([^\]|]+)\]\]$/);
          if (innerMatch) {
            const refName = innerMatch[1].trim().toLowerCase();
            if (
              refName === tgtAttrs.name.toLowerCase() ||
              refName === srcAttrs.name.toLowerCase() ||
              finalAliases.some((a) => a.toLowerCase() === refName)
            ) {
              continue; // Skip self-references
            }
          }
          if (!tgtRelated[key].includes(v)) {
            tgtRelated[key].push(v);
          }
        }
      }

      // Remove self-references from target related too
      for (const [key, vals] of Object.entries(tgtRelated)) {
        tgtRelated[key] = vals.filter((v) => {
          const innerMatch = v.match(/^\[\[([^\]|]+)\]\]$/);
          if (innerMatch) {
            const refName = innerMatch[1].trim().toLowerCase();
            return refName !== srcAttrs.name.toLowerCase();
          }
          return true;
        });
      }

      // --- Merge body ---
      let targetBody = targetParsed.body;
      const sourceBody = sourceParsed.body;

      // Extract evidence blocks from source and append to target
      const srcEvidenceMatch = sourceBody.match(/## Evidence\s*\n([\s\S]*?)(?=\n## Relationships|$)/);
      if (srcEvidenceMatch) {
        const srcEvidence = srcEvidenceMatch[1].trim();
        if (srcEvidence) {
          const relIdx = targetBody.indexOf("## Relationships");
          if (relIdx >= 0) {
            const beforeRel = targetBody.slice(0, relIdx).trimEnd();
            const afterRel = targetBody.slice(relIdx);
            targetBody = beforeRel + "\n\n" + srcEvidence + "\n\n" + afterRel;
          } else {
            targetBody = targetBody.trimEnd() + "\n\n" + srcEvidence + "\n";
          }
        }
      }

      // Extract overview addition from source
      const srcOverviewMatch = sourceBody.match(/## Overview\s*\n([\s\S]*?)(?=\n## Evidence|$)/);
      if (srcOverviewMatch) {
        const srcOverview = srcOverviewMatch[1].trim();
        if (srcOverview) {
          const tgtOverviewIdx = targetBody.indexOf("## Overview");
          const tgtEvidenceIdx = targetBody.indexOf("## Evidence");
          if (tgtOverviewIdx >= 0 && tgtEvidenceIdx >= 0) {
            const existingOverview = targetBody.slice(
              tgtOverviewIdx + "## Overview".length,
              tgtEvidenceIdx
            ).trim();
            // Only append if source overview has content not already present
            if (!existingOverview.includes(srcOverview.slice(0, 50))) {
              targetBody =
                targetBody.slice(0, tgtOverviewIdx) +
                "## Overview\n\n" +
                existingOverview + " " + srcOverview +
                "\n\n" +
                targetBody.slice(tgtEvidenceIdx);
            }
          }
        }
      }

      // Rebuild relationships section from merged related
      const newRelLines = buildRelationshipLines(tgtRelated);
      const relMarkerIdx = targetBody.indexOf("## Relationships");
      if (relMarkerIdx >= 0) {
        const afterRelStart = relMarkerIdx + "## Relationships".length;
        const nextH2 = targetBody.indexOf("\n## ", afterRelStart);
        const relEnd = nextH2 >= 0 ? nextH2 : targetBody.length;
        targetBody = targetBody.slice(0, relMarkerIdx) +
          "## Relationships\n\n" + newRelLines + "\n" +
          targetBody.slice(relEnd);
      }

      // --- Build final content ---
      const relatedYaml = buildRelatedYaml(tgtRelated);
      const aliasesYaml = finalAliases.length > 0
        ? finalAliases.map((a) => `  - "${a}"`).join("\n")
        : "";
      const sourcesYaml = finalSources.map((s) => `  - "${s}"`).join("\n");
      const created = typeof tgtAttrs.created === "string" ? tgtAttrs.created
        : (tgtAttrs.created instanceof Date
          ? (tgtAttrs.created as Date).toISOString().slice(0, 10)
          : today);

      const finalContent = [
        "---",
        `entityType: ${tgtAttrs.entityType}`,
        `name: "${tgtAttrs.name}"`,
        `aliases:${aliasesYaml ? "\n" + aliasesYaml : " []"}`,
        `sources:\n${sourcesYaml}`,
        relatedYaml,
        `created: "${created}"`,
        `updated: "${today}"`,
        "---",
        targetBody,
      ].join("\n");

      // Validate the merged content
      let finalParsedCheck: { attributes: Record<string, unknown>; body: string };
      try {
        finalParsedCheck = fm<Record<string, unknown>>(finalContent);
      } catch (e) {
        return JSON.stringify({ success: false, error: `Merged content has malformed frontmatter: ${e}` });
      }

      const mergeValidationErrors = [
        ...validateEntityFrontmatter(finalParsedCheck.attributes, absTarget, config),
        ...validateEntityBody(finalParsedCheck.body),
      ];
      const mergeHardErrors = mergeValidationErrors.filter((e) => e.severity === "error");
      const mergeWarnings = mergeValidationErrors.filter((e) => e.severity === "warning");

      if (mergeHardErrors.length > 0) {
        return JSON.stringify(
          {
            success: false,
            action: "merge-entities",
            error: "Validation failed on merged content.",
            errors: mergeHardErrors,
            warnings: mergeWarnings,
          },
          null,
          2
        );
      }

      // Write the merged target file
      try {
        writeFileSync(absTarget, finalContent, "utf-8");
      } catch (e) {
        return JSON.stringify({ success: false, error: `Failed to write merged file: ${e}` });
      }

      // Collect all names that should be rewritten to point to the target
      const oldNames = [srcAttrs.name];
      if (isStringArray(srcAttrs.aliases)) {
        for (const alias of srcAttrs.aliases) {
          if (alias.toLowerCase() !== tgtAttrs.name.toLowerCase()) {
            oldNames.push(alias);
          }
        }
      }

      // Rewrite all references across the KB
      const universePath = resolveUniversePath(cwd, universe);
      const dataPath = join(universePath, "data");
      const rewriteResult = rewriteReferencesAcrossKb(
        cwd,
        dataPath,
        oldNames,
        tgtAttrs.name,
        shouldDelete !== false ? sourcePath : undefined
      );

      // Delete source file if requested (default: true)
      let sourceDeleted = false;
      if (shouldDelete !== false) {
        try {
          unlinkSync(absSource);
          sourceDeleted = true;
        } catch (e) {
          // Non-fatal — report but don't fail
          rewriteResult.rewriteDetails.push(`Warning: failed to delete source file: ${e}`);
        }
      }

      return JSON.stringify(
        {
          success: true,
          action: "merge-entities",
          sourcePath,
          targetPath,
          sourceDeleted,
          mergedAliases: finalAliases,
          mergedSources: finalSources.length,
          mergedRelatedKeys: Object.keys(tgtRelated),
          referencesRewritten: rewriteResult.filesModified,
          rewriteDetails: rewriteResult.rewriteDetails,
          warnings: mergeWarnings.length > 0 ? mergeWarnings : undefined,
          message: `Merged ${sourcePath} into ${targetPath}. ${rewriteResult.filesModified} files had references rewritten.${sourceDeleted ? " Source file deleted." : ""}`,
        },
        null,
        2
      );
    }

    // -----------------------------------------------------------------------
    // DELETE-ENTITY action — removes entity file and cleans up references
    // -----------------------------------------------------------------------
    if (action === "delete-entity") {
      if (!relPath) {
        return JSON.stringify({
          success: false,
          error: "The 'path' parameter is required for delete-entity action.",
        });
      }

      const absPath = join(cwd, relPath);
      if (!existsSync(absPath)) {
        return JSON.stringify({ success: false, error: `File not found: ${relPath}` });
      }

      // Read the file to get its name and aliases for reference cleanup
      let content_: string;
      try {
        content_ = readFileSync(absPath, "utf-8");
      } catch (e) {
        return JSON.stringify({ success: false, error: `Failed to read file: ${e}` });
      }

      let parsed_: { attributes: Record<string, unknown>; body: string };
      try {
        parsed_ = fm<Record<string, unknown>>(content_);
      } catch (e) {
        return JSON.stringify({ success: false, error: `Failed to parse frontmatter: ${e}` });
      }

      const attrs_ = parsed_.attributes as EntityFrontmatter;
      const entityName = attrs_.name || basename(relPath, ".md");

      // Collect all names to clean up
      const allNames = [entityName];
      if (isStringArray(attrs_.aliases)) {
        for (const alias of attrs_.aliases) {
          allNames.push(alias);
        }
      }

      // Remove references from other files' related[] arrays and body wikilinks
      // We replace [[DeletedEntity]] with just the plain text (no wikilink)
      const universePath = resolveUniversePath(cwd, universe);
      const dataPath = join(universePath, "data");
      let filesModified = 0;
      const details: string[] = [];

      const entityTypes = getEntityTypeDirsFromPath(dataPath);
      const escapedNames = allNames.map((n) =>
        n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      );
      const linkRegex = new RegExp(
        `\\[\\[(${escapedNames.join("|")})(\\|[^\\]]*)?\\]\\]`,
        "gi"
      );

      for (const entityType of entityTypes) {
        const typeDir = join(dataPath, entityType);
        if (!existsSync(typeDir)) continue;
        const files = readdirSync(typeDir).filter(
          (f) => f.endsWith(".md") && !f.startsWith("_")
        );

        for (const file of files) {
          const filePath = join(typeDir, file);
          const fileRelPath = relative(cwd, filePath).replace(/\\/g, "/");
          if (fileRelPath === relPath) continue; // Skip the file being deleted

          let fileContent: string;
          try {
            fileContent = readFileSync(filePath, "utf-8");
          } catch {
            continue;
          }

          let modified = false;
          try {
            const fmParsed = fm<EntityFrontmatter>(fileContent);
            const fmAttrs = fmParsed.attributes;

            // Remove from related arrays
            if (fmAttrs.related && isRecord(fmAttrs.related)) {
              const relatedObj = fmAttrs.related as Record<string, string[]>;
              for (const [key, vals] of Object.entries(relatedObj)) {
                if (!isStringArray(vals)) continue;
                const filtered = vals.filter((v) => {
                  const innerMatch = v.match(/^\[\[([^\]|]+)(?:\|[^\]]+)?\]\]$/);
                  if (innerMatch) {
                    const refName = innerMatch[1].trim().toLowerCase();
                    return !allNames.some((n) => n.toLowerCase() === refName);
                  }
                  return true;
                });
                if (filtered.length !== vals.length) {
                  relatedObj[key] = filtered;
                  modified = true;
                }
              }
            }

            // Remove wikilinks from body (replace with plain text)
            let body = fmParsed.body;
            const newBody = body.replace(linkRegex, (_match, name) => name);
            if (newBody !== body) {
              body = newBody;
              modified = true;
            }

            if (modified) {
              // Rebuild frontmatter
              const aliasesYaml = isStringArray(fmAttrs.aliases) && fmAttrs.aliases.length > 0
                ? fmAttrs.aliases.map((a) => `  - "${a}"`).join("\n")
                : "";
              const sourcesYaml = isStringArray(fmAttrs.sources)
                ? fmAttrs.sources.map((s) => `  - "${s}"`).join("\n")
                : "";
              const relatedYaml = buildRelatedYaml(
                (fmAttrs.related as Record<string, string[]>) || {}
              );
              const created = typeof fmAttrs.created === "string" ? fmAttrs.created
                : (fmAttrs.created instanceof Date
                  ? (fmAttrs.created as Date).toISOString().slice(0, 10)
                  : new Date().toISOString().slice(0, 10));

              const newFileContent = [
                "---",
                `entityType: ${fmAttrs.entityType}`,
                `name: "${fmAttrs.name}"`,
                `aliases:${aliasesYaml ? "\n" + aliasesYaml : " []"}`,
                `sources:\n${sourcesYaml}`,
                relatedYaml,
                `created: "${created}"`,
                `updated: "${new Date().toISOString().slice(0, 10)}"`,
                "---",
                body,
              ].join("\n");

              writeFileSync(filePath, newFileContent, "utf-8");
              filesModified++;
              details.push(`Cleaned references in ${fileRelPath}`);
            }
          } catch {
            details.push(`Failed to process ${fileRelPath}`);
          }
        }
      }

      // Delete the entity file
      try {
        unlinkSync(absPath);
      } catch (e) {
        return JSON.stringify({ success: false, error: `Failed to delete file: ${e}` });
      }

      return JSON.stringify(
        {
          success: true,
          action: "delete-entity",
          path: relPath,
          entityName,
          referencesCleanedFrom: filesModified,
          details,
          message: `Deleted ${relPath}. Cleaned references from ${filesModified} files.`,
        },
        null,
        2
      );
    }

    // -----------------------------------------------------------------------
    // WRITE actions (write-entity / write-index)
    // -----------------------------------------------------------------------

    // Auto-derive path for write-entity when omitted
    let effectivePath = relPath;
    if (!effectivePath && action === "write-entity" && content) {
      // Try to derive from content frontmatter
      try {
        const tempParsed = fm<Record<string, unknown>>(content);
        const a = tempParsed.attributes;
        if (typeof a.entityType === "string" && typeof a.name === "string") {
          const kbPath = resolveKbPath(cwd);
          effectivePath = `${kbPath}${universe}/data/${a.entityType}/${a.name}.md`;
        }
      } catch {
        // Fall through to error below
      }
    }

    if (!effectivePath) {
      return JSON.stringify({
        success: false,
        error: "The 'path' parameter is required for write actions (or provide entityType + name in frontmatter for auto-derivation).",
      });
    }

    if (!content) {
      return JSON.stringify({
        success: false,
        error: "The 'content' parameter is required for write actions.",
      });
    }

    const absPath = join(cwd, effectivePath);

    // Parse the incoming content's frontmatter
    let parsed: { attributes: Record<string, unknown>; body: string };
    try {
      parsed = fm<Record<string, unknown>>(content);
    } catch (e) {
      return JSON.stringify({
        success: false,
        error: `Malformed YAML frontmatter in provided content: ${e}`,
      });
    }

    // Validate based on action type
    let validationErrors: ValidationError[];
    if (action === "write-index") {
      validationErrors = validateIndexFrontmatter(parsed.attributes, config);
    } else {
      // write-entity
      validationErrors = [
        ...validateEntityFrontmatter(parsed.attributes, absPath, config),
        ...validateEntityBody(parsed.body),
      ];
    }

    const hardErrors = validationErrors.filter((e) => e.severity === "error");
    const warnings = validationErrors.filter((e) => e.severity === "warning");

    if (hardErrors.length > 0) {
      return JSON.stringify(
        {
          success: false,
          action,
          path: effectivePath,
          error: "Validation failed. Fix these errors before writing.",
          errors: hardErrors,
          warnings,
        },
        null,
        2
      );
    }

    // Ensure parent directory exists
    const parentDir = dirname(absPath);
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }

    // Write the file
    try {
      writeFileSync(absPath, content, "utf-8");
    } catch (e) {
      return JSON.stringify({
        success: false,
        error: `Failed to write file: ${e}`,
      });
    }

    return JSON.stringify(
      {
        success: true,
        action,
        path: effectivePath,
        operation: "written",
        warnings: warnings.length > 0 ? warnings : undefined,
        message: `File ${effectivePath} written successfully.${warnings.length > 0 ? ` ${warnings.length} warning(s).` : ""}`,
      },
      null,
      2
    );
  },
});
