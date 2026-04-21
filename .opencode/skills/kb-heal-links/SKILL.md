---
name: kb-heal-links
description: Detect and fix broken/dead wikilinks and missing backlinks in the knowledge base. Repoints mismatched links, creates missing entities from raw data, and repairs bidirectional link gaps.
---

# /kb-heal-links

Detect and repair all link integrity issues in a knowledge base universe: broken wikilinks (pointing to non-existent entities), missing backlinks (A links to B but B doesn't link back), and dead references that can be repointed to existing entities via fuzzy matching.

## Usage

```
/kb-heal-links                          # heal links in the default universe
/kb-heal-links <universe>               # heal links in a specific universe
```

## Recommended Order

If running all three healing skills, run them in this order:
1. `/kb-dedup` — merge duplicates first (reduces broken links and orphans)
2. **`/kb-heal-links`** — fix link integrity (you are here)
3. `/kb-heal-orphans` — reconnect orphaned entities last

## What You Must Do When Invoked

### Step 0 — Identify Universe and Gather Context

1. Determine the universe slug. If not provided, read `.kbaas/kbaas.json` for the default, or list `kb/` directories.
2. Read `kb/<universe>/_meta/entities.json` to understand entity types.
3. Run `kb-index stats` for a KB size overview.

### Step 1 — Detect All Link Issues

Run `kb-backlinks check-all` on the universe. This returns:
- **brokenLinks**: wikilinks pointing to entities that have no file
- **missingBacklinks**: A links to B but B doesn't link back to A

Store both lists — you'll process them in order.

### Step 2 — Fix Broken Links (Phase A)

For each broken link `[[X]]` reported:

**2a. Search for fuzzy matches:**
- Run `kb-search` with `query=X` and `fuzzy=true`
- If a match has score >= 0.7, this is a **repoint candidate**

**2b. If good match found — Repoint:**
1. Read the file containing the broken link
2. Replace `[[X]]` with `[[MatchedName]]` in the body text
3. Update the `related` frontmatter: remove the old reference, add the new one under the correct entity type key
4. Update the `updated` date
5. Write the fixed file via `kb-update write-entity`

**2c. If no good match — Search raw data:**
1. Use `grep` to search `kb/<universe>/_raw/` for mentions of `X` (case-insensitive)
2. If found in raw files, gather the context around each mention
3. Create the missing entity via `kb-update upsert-entity` with:
   - `entityType`: infer from context and the entity config
   - `name`: the entity name from the broken link
   - `newSource`: the raw file where it was found
   - `newEvidence`: the relevant quote from the raw text
   - `newRelated`: cross-references identifiable from context
4. After creating the entity, the broken link is now resolved

**2d. If nothing found — Report as unresolvable:**
- Add to the unresolved list in the healing report
- Do NOT delete the broken wikilink — it serves as a marker for future pipeline runs

**Parallelism:** Process broken links sequentially (each fix may affect subsequent searches). But you can batch the `kb-search` calls using `kb-search-batch` for all broken link targets first, then process results.

### Step 3 — Fix Missing Backlinks (Phase B)

This is typically the bulk of the work (80+ issues in a mature KB).

**Strategy: Batch by target file.** Group all missing backlinks by `fixFile` (the file that needs the backlink added). Then for each file, add all missing backlinks in one operation.

For each group:
1. Gather all the `shouldLinkTo` entities for this file
2. For each missing backlink, determine the correct entity type key (use `kb-search` to find the entity and get its `entityType`)
3. Use `kb-update upsert-entity` to add the missing relationships:
   - `name`: the entity name from the file being fixed
   - `entityType`: the entity type of the file being fixed
   - `newSource`: use the existing file's sources (pick the first one)
   - `newEvidence`: a brief note like "Cross-reference added during link healing"
   - `newRelated`: `{ "<type>": ["[[EntityName]]"] }` for each missing backlink

**Important:** Use `kb-search-batch` to look up all `shouldLinkTo` entity types in one call before processing.

**Parallelism:** You can issue multiple `kb-update upsert-entity` calls in parallel for different files, since they don't conflict.

### Step 4 — Verify

Run `kb-backlinks check-all` again to confirm:
- Broken links count decreased (or reached zero)
- Missing backlinks count decreased significantly
- No new broken links were introduced

### Step 5 — Report

Output the healing report:

```
## Healing Report: Link Integrity

### Summary
- Broken links found: <N>
- Broken links repointed: <N>
- Missing entities created from _raw: <N>
- Broken links unresolvable: <N>
- Missing backlinks found: <N>
- Missing backlinks fixed: <N>

### Repointed Links
- [[OldName]] → [[NewName]] in <file> (fuzzy score: <score>)
- ...

### Entities Created
- <EntityType>/<EntityName> — created from evidence in <raw-file>
- ...

### Backlinks Added
- Added [[X]] backlink to <file> (type: <entity-type>)
- ...

### Unresolved Issues
- [[X]] in <file> — no match found, no raw data available
- ...

### Post-Healing Stats
- Broken links: <before> → <after>
- Missing backlinks: <before> → <after>
```
