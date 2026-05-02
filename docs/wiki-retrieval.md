# Wiki retrieval — unified context assembly

## Motivation

Lossless-Claw's `assemble()` builds model context from a SQLite-backed
DAG of compacted summaries and raw messages. That gives every turn a clean
view of conversation history under a single token budget.

What it does not give you is **reference knowledge** — curated decisions,
syntheses, policies, canon entries that exist outside any one
conversation but should still inform every turn. Today, agents can reach
that knowledge only by issuing tool calls (`memory_search`,
`wiki_search`) and waiting on round-trips. For high-frequency
recall ("what did we decide about X?", "is there canon for Y?"), the
tool-call latency and context cost dominate.

Wiki retrieval extends `assemble()` with a second store: an on-disk
markdown vault. Hits are scored against the live prompt, capped under a
token budget, and injected at the head of assembled context as a
`<wiki-canon>`-wrapped synthetic user message.

This is **two stores, one retrieval surface** — the SQLite store and the
wiki vault stay independent (different lifecycles, different
authoritative writers), but `assemble()` returns a unified prompt with
both kinds of context already allocated.

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                     LcmContextEngine.assemble()                   │
│                                                                   │
│   wikiBudget = computeWikiBudget(tokenBudget)                     │
│              = min(tokenBudget × wikiBudgetFraction,              │
│                    wikiMaxTokens)                                 │
│                                                                   │
│   ContextAssembler.assemble({ ..., wikiBudget, prompt })          │
└────────────┬─────────────────────────────────────────────────────┘
             │
             ▼
┌──────────────────────────────────────────────────────────────────┐
│                   ContextAssembler.assemble()                     │
│                                                                   │
│  1. wikiHits = wikiEngine.searchWiki(prompt, { maxTokens: ... }) │
│  2. tokenBudget := input.tokenBudget − wikiTokensUsed             │
│  3. <existing LCM assembly with reduced tokenBudget>              │
│  4. messages := [wikiMessage, ...lcmMessages]                     │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

The assembler is the single integration point. Wiki retrieval is
intentionally pluggable: `ContextAssembler`'s 4th constructor arg is an
optional `WikiRetrievalEngine`, and the engine's `assemble()` only
passes `wikiBudget > 0` when wiki is enabled. With no wiki engine, the
behavior is identical to v0.9.x.

## WikiRetrievalEngine

`src/wiki/retrieval.ts` exports:

| Symbol | Purpose |
|---|---|
| `class WikiRetrievalEngine` | TTL-cached in-memory index over a markdown vault. |
| `interface WikiEntry` | Parsed entry with id, title, kind, status, tags, body, mtime. |
| `interface WikiHit` | `{ entry, score }`. |
| `function loadWikiEntry(path, vaultRoot)` | Single-file loader (testable). |
| `function parseFrontmatter(raw)` | Lightweight YAML subset (key:value + `- list` items). |
| `function formatWikiHits(hits)` | XML-wrapped content string. |
| `function sumWikiTokens(hits)` | Token estimate including wrapper overhead. |

### Index lifecycle

The index is built lazily on the first `searchWiki()` call and cached in
memory. It refreshes when:

- The next search happens after `refreshIntervalMs` (default 60 s).
- `invalidate()` is called explicitly (used by tests).

Refresh is a full directory walk plus per-file frontmatter parse. For a
~1.4 k-entry vault on local SSD, this completes in under 100 ms — well
within the assemble() budget. Hidden directories (`.git`, `.obsidian`,
…) and underscore-prefixed directories (`_archive`, `_review-queue`) are
skipped.

### Scoring

The wiki engine reuses the existing BM25-lite `scoreRelevance()` from
`assembler.ts` to keep retrieval semantics consistent with the
prompt-aware eviction selector. Three weights tilt the ranking toward
high-precision fields:

| Field | Boost |
|---|---|
| `title` | × 3.0 |
| `tags` | × 1.5 |
| `kind` | × 0.5 |
| body | × 1.0 |

Ties are broken by recency (`modifiedAt`). Entries with `status` in
`{deprecated, archived, superseded, draft}` are excluded.

### Selection under budget

Candidates are sorted by score and walked in order. An entry is
selected if it fits under both `maxEntries` and `maxTokens` simultaneously.
A too-large entry is skipped (not used to short-circuit the loop) so that
smaller, lower-ranked entries can still fill the remaining budget.

## Configuration

Six new `LcmConfig` fields drive wiki retrieval:

| Field | Env var | Default | Notes |
|---|---|---|---|
| `wikiEnabled` | `LCM_WIKI_ENABLED` | `true` | Master switch. |
| `wikiVaultPath` | `LCM_WIKI_VAULT_PATH` | `<stateDir>/wiki/main` | Resolved relative to `OPENCLAW_STATE_DIR` for multi-profile hosts. |
| `wikiBudgetFraction` | `LCM_WIKI_BUDGET_FRACTION` | `0.30` | Clamped to `[0, 1]`. |
| `wikiMaxTokens` | `LCM_WIKI_MAX_TOKENS` | `8000` | Hard cap on wiki tokens regardless of fraction. |
| `wikiMaxEntries` | `LCM_WIKI_MAX_ENTRIES` | `8` | Hard cap on entries per assemble. |
| `wikiRefreshIntervalMs` | `LCM_WIKI_REFRESH_INTERVAL_MS` | `60_000` | Index TTL. |

The wiki budget at assemble time is `min(tokenBudget × fraction, maxTokens)`.
At the default 30 % fraction with a 128 k assembly budget, the cap fires
first (8 k wins over 38 k).

To disable wiki retrieval entirely without touching config files:

```sh
LCM_WIKI_ENABLED=false
```

## Wiki entry format

Entries are markdown files with optional YAML frontmatter:

```markdown
---
id: canon.topic.hammer-anvil-cycle
title: "Hammer/Anvil cycle"
kind: canon-topic
status: active
tags:
  - hammer-anvil
  - cycle
  - automation
---

The Hammer/Anvil cycle pairs Claude (hammer) with Codex (anvil) for
verified PRs. ...
```

| Frontmatter field | Effect |
|---|---|
| `id` | Cited in injected XML. Falls back to dotted relative path. |
| `title` | Boosted in scoring; included in XML attributes. |
| `kind` | Lightly boosted; included in XML attributes. |
| `status` | Filters out deprecated/archived/superseded/draft on retrieval. |
| `tags` | Boosted in scoring; included in XML attributes (comma-joined). |

Files without frontmatter are still indexed (id derived from path,
status defaults to active).

## Injected message format

When wiki hits are present, a single synthetic user message is prepended
to the assembled messages:

```
<wiki-canon>
  <preamble>
    Reference knowledge from your local wiki canon — curated decisions,
    syntheses, and policies. These entries are NOT conversation history;
    treat them as static knowledge and cite by id when used.
  </preamble>
  <entry id="canon.topic.hammer-anvil-cycle"
         title="Hammer/Anvil cycle"
         kind="canon-topic"
         tags="hammer-anvil,cycle,automation">
    The Hammer/Anvil cycle pairs Claude (hammer) with Codex (anvil) ...
  </entry>
  ...
</wiki-canon>
```

The wrapper signals to the model that this is reference knowledge, not
conversation history. The preamble instructs citing-by-id; the
attributes give the model enough metadata to disambiguate. Attribute
values are XML-escaped.

Token accounting: wiki tokens are deducted from the LCM budget *before*
LCM assembly runs, so the combined prompt stays within
`input.tokenBudget`. If the wiki engine returns zero hits, the LCM
assembly still ran with the reduced budget — harmless, just a slightly
smaller final prompt.

## Diagnostics

`AssembleContextResult.debug` gains three fields:

| Field | Description |
|---|---|
| `wikiHitCount` | Number of injected wiki entries. |
| `wikiTokens` | Estimated tokens consumed by injection (incl. wrapper). |
| `lcmBudget` | Token budget actually allocated to LCM history. |

These are zero when wiki is disabled, the prompt is missing, or the
vault is empty. `WikiRetrievalEngine.diagnostics()` exposes additional
state for debugging (`vaultPath`, `vaultExists`, `indexBuiltAt`,
`entryCount`).

## Trade-offs

**Why not store wiki entries in the SQLite DB?** The wiki vault is
authoritatively maintained outside the LCM lifecycle (e.g. via an
external mirror from a remote canonical store). Importing into SQLite
would either require duplicating the watcher logic in this plugin or
accepting a stale view. Two stores keep the lifecycles independent.

**Why prepend rather than interleave?** Wiki entries are not
chronologically anchored — they are static reference knowledge. Placing
them at the head, behind a clear `<wiki-canon>` wrapper, lets the model
attend to them as a frame for the conversation rather than treating
them as old turns.

**Why not embed-based retrieval?** BM25-lite gives consistent semantics
with the existing prompt-aware eviction (so query terms behave the same
across the two stores) and avoids a model dependency. Embedding-based
retrieval is a sensible v2 enhancement for users who want it; the
`WikiRetrievalEngine` interface is small enough to swap.

**Why not pre-load the entire vault?** A typical vault has thousands of
entries totalling well past 100 k tokens. The retrieval pass picks
relevant entries per turn; the in-memory index just avoids the disk
scan.

## Limitations

- **No per-agent filtering at retrieval time.** Agents are scoped at
  the directory layer (the host runtime decides which vault to mount).
  Frontmatter `agent:` filtering is a v2 feature if needed.
- **No vault-write API.** The plugin reads only. Wiki authoring stays
  the responsibility of upstream pipelines.
- **No remote fallback.** If the local mirror lags the canonical
  source, retrieval reflects the lag. A remote fallback would add
  network latency to every assemble; the watcher pipeline is the right
  place to fix mirror staleness.
- **Empty-LCM conversations get no wiki.** When `assemble()` falls back
  to live messages (no context items yet), the wiki path is skipped.
  Wiki injection on brand-new conversations is a v2 feature.
