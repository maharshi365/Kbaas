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
} from "node:fs";
import { join, basename, dirname } from "node:path";

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
    if (!isRecord(attrs.related)) {
      errors.push({
        field: "related",
        message: "related must be an object",
        severity: "error",
      });
    } else {
      for (const [key, val] of Object.entries(attrs.related)) {
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
// Tool: kb-update
// ---------------------------------------------------------------------------

export default tool({
  description:
    "Write or verify knowledge base entity files with built-in validation. " +
    "Actions: 'write-entity' validates frontmatter + body structure then writes an entity .md file; " +
    "'write-index' validates index frontmatter then writes an _index.md file; " +
    "'verify' validates an existing file, type folder, or entire KB without writing. " +
    "This tool reads _meta/entities.json at runtime to enforce universe-specific rules. " +
    "All writes go through validation — invalid content is rejected with detailed error messages.",
  args: {
    universe: tool.schema
      .string()
      .describe("Universe slug (e.g. 'willverse')"),
    action: tool.schema
      .enum(["write-entity", "write-index", "verify"])
      .describe(
        "Action: 'write-entity' to create/update an entity file, 'write-index' for _index.md, 'verify' for read-only validation"
      ),
    path: tool.schema
      .string()
      .optional()
      .describe(
        "Relative file path for write actions (e.g. 'kb/<slug>/data/characters/Entity Name.md'). " +
        "For verify: a specific file, or a type folder (e.g. 'kb/<slug>/data/characters/'), or omit to verify the whole KB."
      ),
    content: tool.schema
      .string()
      .optional()
      .describe(
        "Full markdown content to write (required for write-entity and write-index). " +
        "Must include YAML frontmatter delimited by --- and the markdown body."
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
    // WRITE actions (write-entity / write-index)
    // -----------------------------------------------------------------------
    if (!relPath) {
      return JSON.stringify({
        success: false,
        error: "The 'path' parameter is required for write actions.",
      });
    }

    if (!content) {
      return JSON.stringify({
        success: false,
        error: "The 'content' parameter is required for write actions.",
      });
    }

    const absPath = join(cwd, relPath);

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
          path: relPath,
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

    const isNew = !existsSync(absPath);
    // Re-check: the write just happened so the file definitely exists now
    return JSON.stringify(
      {
        success: true,
        action,
        path: relPath,
        operation: isNew ? "created" : "written",
        warnings: warnings.length > 0 ? warnings : undefined,
        message: `File ${relPath} written successfully.${warnings.length > 0 ? ` ${warnings.length} warning(s).` : ""}`,
      },
      null,
      2
    );
  },
});
