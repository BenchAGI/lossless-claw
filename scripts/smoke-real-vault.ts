/**
 * Real-vault smoke test for WikiRetrievalEngine.
 *
 * Points the engine at the user's actual ~/.openclaw/wiki/main, runs a
 * battery of canonical queries, and prints rankings. Used as a
 * calibration step alongside automated unit tests — surfaces issues
 * (parser breakage on real frontmatter, scoring drift, kind boost
 * tilt) that synthetic fixtures can't reach.
 *
 * Run with:  npx tsx scripts/smoke-real-vault.ts
 *           [VAULT_PATH=/abs/path/to/vault] [QUERY="my query"]
 *
 * Not part of the test suite — kept under scripts/ so it doesn't run in
 * CI but can be invoked locally for tuning.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { WikiRetrievalEngine } from "../src/wiki/retrieval.js";

const VAULT_PATH = process.env.VAULT_PATH ?? join(homedir(), ".openclaw", "wiki", "main");
const SINGLE_QUERY = process.env.QUERY;

const CANONICAL_QUERIES = [
  "hammer anvil cycle",
  "wiki canon pipeline",
  "memory probe",
  "rollout phase 5",
  "agent slack identity gate",
  "rate limiter token budget",
  "openclaw fork install layout",
  "personal triage gmail",
  "Bench team contacts Jim Jory",
  "auto memory consolidation",
];

type RunResult = {
  query: string;
  hits: number;
  topScore: number;
  buildMs: number;
  searchMs: number;
  examples: Array<{ score: number; id: string; kind: string; title: string }>;
};

function fmtMs(n: number): string {
  return `${n.toFixed(1)}ms`;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}

function runOne(engine: WikiRetrievalEngine, query: string): RunResult {
  const sBuild = performance.now();
  // Force a refresh on the first call by checking size().
  const size = engine.size();
  const buildMs = performance.now() - sBuild;
  const sSearch = performance.now();
  const hits = engine.searchWiki(query, { maxEntries: 8, maxTokens: 8000 });
  const searchMs = performance.now() - sSearch;
  return {
    query,
    hits: hits.length,
    topScore: hits[0]?.score ?? 0,
    buildMs,
    searchMs,
    examples: hits.slice(0, 5).map((h) => ({
      score: Number(h.score.toFixed(3)),
      id: h.entry.id,
      kind: h.entry.kind,
      title: h.entry.title,
    })),
  };
}

function main(): void {
  const queries = SINGLE_QUERY ? [SINGLE_QUERY] : CANONICAL_QUERIES;
  console.log(`# Wiki retrieval smoke — vault=${VAULT_PATH}`);

  const engine = new WikiRetrievalEngine({
    vaultPath: VAULT_PATH,
    refreshIntervalMs: 60_000,
  });

  // Warm the index once so per-query timings reflect search-only cost.
  const warmStart = performance.now();
  const indexed = engine.size();
  const warmMs = performance.now() - warmStart;
  console.log(`# Indexed ${indexed} entries in ${fmtMs(warmMs)}\n`);

  let blanks = 0;
  for (const query of queries) {
    const r = runOne(engine, query);
    console.log(`## ${query}`);
    console.log(`- hits: ${r.hits}, top score: ${r.topScore.toFixed(3)}, search: ${fmtMs(r.searchMs)}`);
    if (r.hits === 0) {
      blanks++;
      console.log(`  (no hits)\n`);
      continue;
    }
    for (const ex of r.examples) {
      console.log(`  ${String(ex.score).padStart(7)}  [${ex.kind || "(no kind)"}]  ${truncate(ex.title, 70)}  — ${ex.id}`);
    }
    console.log("");
  }

  console.log(`# Done. Queries: ${queries.length}, zero-hit: ${blanks}`);
  if (blanks > queries.length / 2) {
    console.log("# Warning: more than half of canonical queries returned 0 hits — investigate scoring");
    process.exit(1);
  }
}

main();
