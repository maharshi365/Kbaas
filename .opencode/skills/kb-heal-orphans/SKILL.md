---
name: kb-heal-orphans
description: Detect orphaned entities (zero incoming links) and reconnect them by searching raw source data for missed connections. Creates missing cross-references to integrate orphans into the knowledge graph.
---

# /kb-heal-orphans

Detect entities with zero incoming links (orphans) in a knowledge base universe and attempt to reconnect them by searching the raw source files (`_raw/`) for mentions that the extraction pipeline missed. Creates missing cross-references to integrate orphans into the knowledge graph.

## Usage

```
/kb-heal-orphans                       # heal orphans in the default universe
/kb-heal-orphans <universe>            # heal orphans in a specific universe
/kb-heal-orphans <universe> --approve-tier2  # allow Tier 2 operations (entity create/merge/delete/rehome)
```

## Two-Tier Policy

- Tier 1 fixes must run automatically for high-confidence, low-risk reconnections discovered in this run.
- Tier 2 fixes require explicit approval. In this workflow, Tier 2 is approved only when `--approve-tier2` is present.
- When invoking `kb-healer`, pass `Tier2Approval: granted` only if `--approve-tier2` was provided; otherwise pass `Tier2Approval: not-granted`.
- Never claim "Tier 1 applied" unless at least one `kb-update` write action succeeded.

## Recommended Order

If running all three healing skills, run them in this order:
1. `/kb-dedup` — merge duplicates first (reduces false orphans)
2. `/kb-heal-links` — fix link integrity (may resolve some orphans)
3. **`/kb-heal-orphans`** — reconnect remaining orphans (you are here)

## What You Must Do When Invoked

### Step 0 — Identify Universe and Gather Context

1. Determine the universe slug. If not provided, read `.kbaas/kbaas.json` for the default, or list `kb/` directories.
2. Read `kb/<universe>/_meta/entities.json` to understand entity types.
3. Read `kb/<universe>/_meta/wiki-rules.md` if it exists. Treat these rules as advisory constraints for naming, linking style, and relationship phrasing while healing.
4. Run `kb-index stats` for a KB size overview.
5. Verify that `kb/<universe>/_raw/` exists and contains source files. If it doesn't exist, report that orphan healing requires raw data and stop.

### Step 1 — Detect Orphans

Run `kb-backlinks find-orphans` on the universe. This returns entities with zero incoming links from other entity files.

For each orphan, note:
- `path`: where the entity file lives
- `name`: the canonical entity name
- `entityType`: what kind of entity it is
- `outgoingLinks`: how many entities it links TO (an orphan can still link out)
- `sources`: what source files contributed to it

### Step 2 — Research Each Orphan

For each orphan entity:

**2a. Read the orphan file** to understand what it is (name, aliases, entity type, overview).

**2b. Search raw files for mentions:**
- Use `grep` to search `kb/<universe>/_raw/` for the orphan's canonical name (case-insensitive)
- Also search for each alias
- Record which raw files mention the orphan and the surrounding context (a few lines around each match)

**2c. Identify which existing entities should reference the orphan:**
- From the grep context, determine which OTHER entities appear near the orphan's mention
- Use `kb-search-batch` to confirm those entities exist in the KB
- For each confirmed co-occurrence: this is a missed connection that should be added

**2d. Classify the orphan:**

| Classification | Criteria | Action |
|---------------|----------|--------|
| **Reconnectable** | Found in raw data near other known entities | Add cross-references |
| **Self-sufficient** | Has outgoing links but nothing links back (normal for some entities) | Add backlinks from linked entities |
| **Over-extracted** | Appears only once in raw data, no meaningful connections | Report as possible quality issue |
| **Misnamed** | Name doesn't match raw data mentions (extraction error) | Report for manual review |

### Step 3 — Reconnect Orphans

For each reconnectable orphan:

**3a. Add references FROM other entities TO the orphan:**
For each entity that should reference the orphan (identified in Step 2c):
```
kb-update action=upsert-entity universe=<slug>
  upsertData={
    "entityType": "<referrer's type>",
    "name": "<referrer's name>",
    "newSource": "<raw file where co-occurrence was found>",
    "newEvidence": "Cross-reference identified during orphan healing from <raw-file>.",
    "newRelated": { "<orphan's type>": ["[[<orphan name>]]"] }
  }
```

**3b. For self-sufficient orphans (have outgoing links but no incoming):**
- Check each entity the orphan links to
- For each, verify if a backlink exists. If not, add one via `kb-update upsert-entity`
- This is similar to the missing backlinks fix in `/kb-heal-links` but targeted at orphans specifically

**Parallelism:** Multiple `upsert-entity` calls for DIFFERENT entities can run in parallel.

### Step 4 — Verify

Run `kb-backlinks find-orphans` again to confirm the orphan count decreased.

Compare before vs after:
- How many orphans were resolved?
- Are any remaining orphans expected (truly isolated entities)?

Also collect execution counters for Tier 1 writes:
- `kb-update` writes attempted
- successful writes (`"success": true`)
- failed writes (with top error reasons)

### Step 5 — Report

Output the orphan healing report:

```
## Healing Report: Orphan Reconnection

### Summary
- Orphans detected: <N>
- Orphans reconnected: <N>
- Orphans self-sufficient (backlinks added): <N>
- Orphans unresolvable: <N>
- Tier 1 write attempts: <N>
- Tier 1 write successes: <N>
- Tier 1 write failures: <N>

### Reconnections Made
- <OrphanType>/<OrphanName>:
  - Found in: <raw-file-1>, <raw-file-2>
  - Added as reference in: <EntityA>, <EntityB>
  - Context: "<brief quote showing the connection>"
- ...

### Backlinks Added (Self-Sufficient Orphans)
- Added [[<Orphan>]] backlink to <EntityX> (was already linked by orphan)
- ...

### Unresolved Orphans
- <OrphanType>/<OrphanName>: <reason> (e.g., "only 1 mention in raw data, no co-occurring entities")
- ...

### Post-Healing Stats
- Orphans: <before> → <after>

### Execution Notes
- If `Tier 1 write successes = 0`, explicitly state: "Tier 1 attempted but not applied" and list top failure reasons.
- Do not present attempted actions as completed actions.
```
