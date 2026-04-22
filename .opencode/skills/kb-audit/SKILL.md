---
name: kb-audit
description: Audit KB entity quality by questioning the researcher and comparing to raw source ground truth. Detects negative signals (unsupported claims, hallucinated relationships), scores entity completeness, and applies improvements.
---

# /kb-audit

Audit the quality of knowledge base entities by interrogating the researcher agent with targeted questions and comparing answers to raw source ground truth. Identifies content gaps, detects **negative signals** (hallucinated relationships, fabricated evidence, unsupported claims), scores completeness, and applies safe improvements.

## Usage

```
/kb-audit                                  # audit a smart-selected entity in the default universe
/kb-audit <universe>                       # audit in a specific universe
/kb-audit <universe> --entity="Lindon"     # audit a specific entity
/kb-audit <universe> --type=characters     # constrain selection to an entity type
/kb-audit <universe> --count=3             # audit N entities in sequence
/kb-audit <universe> --approve-tier2       # allow Tier 2 improvements (entity creation, major rewrites)
```

## Two-Tier Policy

- Tier 1 fixes (adding missing evidence, missing relationships, missing backlinks) are applied automatically when confidence is high.
- Tier 2 fixes (new entity creation, content corrections, major rewrites, **removal of unsupported content**) require explicit approval via `--approve-tier2`.
- Negative signal removals (unsupported relationships, fabricated evidence, hallucinated claims) are **always Tier 2** — never auto-remove content.
- Never claim "Tier 1 applied" unless at least one `kb-update` write action succeeded.

## Recommended Use

Run `/kb-audit` periodically after pipeline processing to catch content quality issues that structural healing skills don't address:

1. `/kb-dedup` — merge duplicates
2. `/kb-heal-links` — fix link integrity
3. `/kb-heal-orphans` — reconnect orphans
4. **`/kb-audit`** — audit content quality (you are here)

The audit is also useful after ingesting new source material to verify the pipeline captured key facts.

## What You Must Do When Invoked

### Step 0 — Parse Arguments & Identify Universe

1. Parse the invocation for universe slug, `--entity`, `--type`, `--count`, and `--approve-tier2`.
2. If no universe provided, read `.kbaas/kbaas.json` for the default, or list `kb/` directories.
3. Read `kb/<universe>/_meta/entities.json` to understand entity types and extraction focus.
4. Read `kb/<universe>/_meta/wiki-rules.md` if it exists.
5. Run `kb-index stats` for a KB size overview.
6. Verify `kb/<universe>/_raw/` exists and contains source files. Auditing requires raw ground truth.

### Step 1 — Select Entity

**If `--entity` was specified:**
- Use `kb-search` to find the entity. If not found, report error and stop.

**If `--type` was specified:**
- Use `kb-index list` filtered to that type. Apply smart selection within the type.

**Otherwise — Smart Selection:**
1. Run `kb-index list` to get all entities grouped by type.
2. Sample ~15-20 entity files across types (proportional to type size).
3. Read each sampled file and score using priority heuristics:
   - Fewer sources = higher priority
   - Shorter overview = higher priority
   - Fewer related entries = higher priority
   - Fewer incoming links = higher priority (check via `kb-backlinks check` for top candidates)
4. Select the highest-priority entity.

Report the selected entity and selection reason.

### Step 2 — Assemble Ground Truth

1. Read the selected entity file fully.
2. Extract `sources` from frontmatter.
3. Map each source to `_raw/<source>.md` files. Read them.
4. Read 1-hop neighbor entities (from `related` frontmatter) for cross-reference context.
5. Build a ground truth dossier.

If no `_raw/` files are found for the entity's sources, select a different entity (return to Step 1).

### Step 2b — Negative Signal Scan

With entity file and ground truth assembled, scan for unsupported content:

1. **Unsupported relationships**: Verify each `related` entity actually co-occurs with the audited entity in `_raw/`. Flag UNSUPPORTED_LINK if not.
2. **Fabricated evidence**: Verify each `## Evidence` quote appears in the corresponding `_raw/` source. Flag FABRICATED_EVIDENCE if not.
3. **Unsupported overview claims**: Check each factual claim in `## Overview` against evidence and `_raw/`. Flag UNSUPPORTED_CLAIM if ungrounded.
4. **Phantom references**: Check `## Relationships` for entities that don't exist in KB and aren't in `_raw/`. Flag PHANTOM_REFERENCE.

Build a negative signals list for use in question generation and the final report.

### Step 3 — Generate Audit Questions

Using `extractionFocus` from `entities.json` for this entity type and the raw source content, generate 6-10 questions:

- 1-2 **Identity** questions (who/what, aliases, basic attributes)
- 1-2 **Relationship** questions (connections, affiliations)
- 1-2 **Event/Action** questions (key actions, participation)
- 1 **Cross-reference** question (relation to another entity from same raw source)
- 1 **Completeness probe** (specific detail in `_raw/` to test if KB captured it)
- 1-2 **Negative signal probes** (ask about relationships/claims the entity file asserts but `_raw/` doesn't support — tests whether the researcher repeats unsupported claims)

All positive questions must be answerable from `_raw/` ground truth. Negative probes deliberately target unsupported content.

### Step 4 — Interrogate the Researcher

Dispatch the `researcher` agent (via Task tool, `subagent_type: "researcher"`) for each question sequentially:

```
Task tool:
  subagent_type: "researcher"
  description: "Audit Q<N> for <EntityName>"
  prompt: |
    Universe: <slug>

    Answer the following question using the knowledge base.
    Follow your standard retrieval workflow and response contract.

    Question: <question text>
```

Capture from each response:
- Answer text
- KB entities cited
- Whether `_raw/` fallback was needed
- Friction level
- Any self-healing applied

### Step 5 — Score Answers

Compare each answer to ground truth:

| Score | Criteria |
|-------|----------|
| **COMPLETE** | Matches `_raw/` truth, backed by KB entity citations |
| **PARTIAL** | Correct but KB is missing details from `_raw/` |
| **MISSING** | Researcher couldn't answer or fell back to `_raw/` |
| **WRONG** | Contradicts `_raw/` ground truth |
| **HALLUCINATED** | Researcher confidently repeats unsupported claim from KB |

Compute quality score: `COMPLETE / total` as percentage. Flag entities with any HALLUCINATED findings as needing urgent review.

### Step 6 — Plan Improvements

- **PARTIAL** → Tier 1: add missing evidence/relationships via `kb-update upsert-entity`
- **MISSING** → Tier 2: may require entity creation or major additions
- **WRONG** → Tier 2: flag for manual review, never auto-correct contradictions
- **HALLUCINATED / Negative signals** → Tier 2: propose removal of unsupported relationships, fabricated evidence, and ungrounded claims. Never auto-remove.

### Step 7 — Apply Improvements

**Tier 1 (automatic):** Execute `kb-update upsert-entity` for evidence and relationship additions. Validate with `kb-update verify`.

**Tier 2 (approval required):** Only apply if `--approve-tier2` was specified. Otherwise report as proposals.

### Step 8 — Report

Output the audit report following the format specified in the kb-auditor agent prompt:
- Entity profile and selection reason
- Questions & scores table (including HALLUCINATED scores)
- Negative signals detected table (type, content, sources checked, confidence, researcher confirmation)
- Quality score percentage
- Researcher friction summary
- Tier 1 improvements applied (with truthfulness gate)
- Tier 2 proposals — split into Content Additions and Negative Signal Removals
- Recommendations (including urgent review flags for HALLUCINATED findings)

### Multi-Entity (--count=N)

If `--count=N` was specified, repeat Steps 1-8 for N entities sequentially. Do not re-audit the same entity within one batch. Append a batch summary table at the end.
