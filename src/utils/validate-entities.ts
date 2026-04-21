import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

const nonEmptyStringSchema = z.string().trim().min(1);

const EVIDENCE_INSTRUCTION =
  "Provide a direct quote or a tight source-grounded excerpt that supports the extracted facts for this entity.";

const entitySchema = z.object({
  name: nonEmptyStringSchema,
  description: nonEmptyStringSchema,
  extractionFocus: nonEmptyStringSchema,
  examples: z.array(nonEmptyStringSchema).min(1),
  evidence: z.literal(EVIDENCE_INSTRUCTION).default(EVIDENCE_INSTRUCTION),
  rules: z.array(nonEmptyStringSchema).optional(),
  invalid: z.array(nonEmptyStringSchema).optional(),
  requiredEntities: z.array(nonEmptyStringSchema).optional(),
});

export const entitiesFileZodSchema = z
  .object({
    schema: z.string().trim().url(),
    value: z.array(entitySchema),
  })
  .superRefine((data, ctx) => {
    const names = new Set(data.value.map((entity) => entity.name));

    for (const [index, entity] of data.value.entries()) {
      if (!entity.requiredEntities) {
        continue;
      }

      for (const requiredEntity of entity.requiredEntities) {
        if (!names.has(requiredEntity)) {
          ctx.addIssue({
            code: "custom",
            message: `Unknown required entity '${requiredEntity}'.`,
            path: ["value", index, "requiredEntities"],
          });
        }

        if (requiredEntity === entity.name) {
          ctx.addIssue({
            code: "custom",
            message: "Entity cannot require itself.",
            path: ["value", index, "requiredEntities"],
          });
        }
      }
    }
  });

export type EntitiesFile = z.infer<typeof entitiesFileZodSchema>;

export const validateEntitiesFile = (filePath: string): EntitiesFile => {
  const absolutePath = resolve(filePath);

  let parsedJson: unknown;

  try {
    parsedJson = JSON.parse(readFileSync(absolutePath, "utf-8"));
  } catch {
    throw new Error(`Invalid JSON in ${absolutePath}.`);
  }

  const result = entitiesFileZodSchema.safeParse(parsedJson);

  if (!result.success) {
    const issue = result.error.issues[0];
    throw new Error(`Invalid entities file: ${issue?.message ?? "validation failed"}.`);
  }

  return result.data;
};

export const buildExtractionSchema = (entitiesFile: EntitiesFile) => {
  const [firstEntityName, ...restEntityNames] = entitiesFile.value.map(
    (entity) => entity.name,
  );
  const entityTypeSchema = z.enum([
    firstEntityName,
    ...restEntityNames,
  ] as [string, ...string[]]);

  const optionalEntityFields: Record<string, z.ZodOptional<z.ZodArray<z.ZodString>>> = {};
  for (const entity of entitiesFile.value) {
    for (const req of entity.requiredEntities ?? []) {
      optionalEntityFields[req] ??= z
        .array(z.string().trim().min(1))
        .min(1)
        .optional();
    }
  }

  return z.object({
    entities: z.array(
      z.object({
        entityType: entityTypeSchema,
        value: z.string().trim().min(1),
        evidence: z.string().trim().min(1),
        ...optionalEntityFields,
      }),
    ),
  });
};
