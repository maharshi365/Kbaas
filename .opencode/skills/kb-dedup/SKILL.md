---
name: kb-dedup
description: Detect and merge duplicate entities in the knowledge base. Finds entities with overlapping names/aliases across files and type folders, merges them atomically, and rewrites all references.
---

# /kb-dedup

Detect duplicate entities in a knowledge base universe and merge them using the atomic `merge-entities` tool action. Handles same-name duplicates, "The X" vs "X" variants, alias overlaps, cross-type duplicates, and high fuzzy-match pairs.

## Usage

```
/kb-dedup                              # dedup the default universe
/kb-dedup <universe>                   # dedup a specific universe
/kb-dedup <universe> --dry-run         # detect only, do not merge
```

## Recommended Order

If running all three healing skills, run them in this order:
1. **`/kb-dedup`** — merge duplicates first (you are here)
2. `/kb-heal-links` — fix link integrity after dedup
3. `/kb-heal-orphans` — reconnect orphaned entities last

## What You Must Do When Invoked

### Step 0 — Identify Universe and Gather Context

1. Determine the universe slug. If not provided, read `.kbaas/kbaas.json` for the default, or list `kb/` directories.
2. Read `kb/<universe>/_meta/entities.json` to understand entity types and their descriptions.
3. Run `kb-index list` to get all entity names grouped by type.
4. Run `kb-index stats` for a size overview.

### Step 1 — Build Candidate Duplicate Pairs

Using the entity list from Step 0, detect candidate pairs using these heuristics:

**1a. "The X" prefix matching:**
For every entity named "The X", check if an entity named "X" exists (or vice versa). This is the most common duplicate pattern.

**1b. Alias overlap:**
Read entity files and check if Entity A's name matches any of Entity B's aliases, or vice versa. Use `kb-search-batch` with all entity names to find cross-matches.

**1c. Same name across different type folders:**
Check if the same entity name appears in multiple entity type folders (e.g., "Li clan" in both `factions/` and `organizations/`).

**1d. High fuzzy-match pairs:**
For entities within the same type folder, use `kb-search-batch` with each entity name. Any cross-match with score >= 0.85 (that isn't the entity itself) is a candidate.

**Deduplication of candidates:** If pair (A,B) is found by multiple heuristics, keep only one entry.

### Step 2 — Classify Each Candidate Pair

For each candidate pair, read both entity files and classify:

| Classification | Criteria | Action |
|---------------|----------|--------|
| **Definite duplicate** | Same entity, different files. One may have richer content. | Merge into the richer file |
| **Type split** | Same real-world concept filed under two types (e.g., event + location). | Merge into the more appropriate type |
| **False positive** | Different entities with similar names. | Skip, report as reviewed |

**Classification heuristics:**
- If one file has the other's name as an alias → definite duplicate
- If evidence quotes describe the same thing → definite duplicate
- If one has strictly more sources than the other → definite duplicate (the smaller is a subset)
- If they're in different type folders but describe the same real-world thing → type split
- If evidence describes genuinely different things → false positive

### Step 3 — Execute Merges

For each confirmed duplicate or type split:

**3a. Determine source (loser) and target (winner):**
- The file with MORE sources is the target (survivor)
- If equal sources, the file with MORE evidence blocks is the target
- If still equal, the file with MORE relationships is the target
- For type splits: the entity type that better matches the entity's nature is the target (e.g., an organization should be in `organizations/`, not `factions/`)

**3b. Execute the merge:**
```
kb-update action=merge-entities universe=<slug> sourcePath=<source> targetPath=<target> deleteSource=true
```

The `merge-entities` action atomically:
1. Merges aliases (source name becomes target alias)
2. Merges sources (union, dedup)
3. Merges related (union, dedup, removes self-references)
4. Appends source evidence to target
5. Appends source overview additions
6. Rebuilds relationship section
7. Validates merged content
8. Writes target file
9. Rewrites ALL references across the KB (body wikilinks + frontmatter related arrays)
10. Deletes source file

**3c. Process sequentially:** Merges must be sequential because each merge changes the KB state that subsequent merges depend on.

**If `--dry-run` was specified:** Skip this step entirely. Just report what would be merged.

### Step 4 — Post-Merge Cleanup

After all merges:
1. Run `kb-backlinks check-all` to verify no new broken links were created
2. Run `kb-update verify` on any files that were modified during reference rewriting
3. If new issues are found, attempt to fix them

### Step 5 — Report

Output the dedup report:

```
## Healing Report: Deduplication

### Summary
- Candidate pairs found: <N>
- Confirmed duplicates: <N>
- Type splits: <N>
- False positives: <N>
- Merges executed: <N>
- References rewritten: <N> files

### Merges Performed
- MERGED: <SourceType>/<SourceName> → <TargetType>/<TargetName>
  - Reason: <why this was a duplicate>
  - Sources merged: <N> + <N> = <N>
  - Aliases added: <list>
  - References rewritten in: <N> files
- ...

### False Positives Reviewed
- <EntityA> vs <EntityB> — different entities (reason: <explanation>)
- ...

### Post-Merge Integrity
- Broken links: <N> (should be 0 or reduced)
- Validation errors: <N>
```
