/**
 * Wiki retrieval engine — augments LCM assembly with curated knowledge
 * from a local markdown vault (e.g. ~/.openclaw/wiki/main).
 *
 * Two-store design (per ADR-2026-05-02): the SQLite-backed LCM history
 * and the on-disk wiki are queried as separate stores under a single
 * token budget allocated by the assembler. The wiki vault is a curated,
 * human-serviceable knowledge base — typically per-instance scoped at
 * the directory layer by the OpenClaw runtime — and is never merged
 * into the LCM SQLite store.
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { scoreRelevance, tokenizeText } from "../assembler.js";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const DEFAULT_REFRESH_MS = 60_000;
const TITLE_BOOST = 3.0;
const TAGS_BOOST = 1.5;
const KIND_BOOST = 0.5;
const WIKI_WRAPPER_TOKEN_OVERHEAD = 64;
const WIKI_ENTRY_TOKEN_OVERHEAD = 24;

/** Status values that mark an entry as no longer authoritative. */
const NON_ACTIVE_STATUSES = new Set(["deprecated", "archived", "superseded", "draft"]);

export interface WikiEntry {
  /** Stable id from frontmatter, or normalized relative path. */
  id: string;
  /** Absolute path on disk. */
  path: string;
  /** Path relative to the vault root (e.g. "canon/topics/foo.md"). */
  relativePath: string;
  /** Human-readable title from frontmatter, or the relative path. */
  title: string;
  /** Frontmatter `kind` (e.g. canon-topic, dream, synthesis). */
  kind: string;
  /** Frontmatter `status`; defaults to "active" when absent. */
  status: string;
  /** Frontmatter tag list (filtered to strings). */
  tags: string[];
  /** Body text excluding the frontmatter block. */
  body: string;
  /** Approximate token count for body (~4 chars / token). */
  bodyTokens: number;
  /** File mtime for recency tie-breaking. */
  modifiedAt: Date;
}

export interface WikiHit {
  entry: WikiEntry;
  score: number;
}

export interface WikiSearchOptions {
  /** Hard cap on selected entries. */
  maxEntries: number;
  /** Hard cap on estimated formatted wiki tokens, including wrapper overhead. */
  maxTokens: number;
  /**
   * Optional agent identifier. Reserved for future per-agent filtering
   * via frontmatter — today the vault is directory-scoped per-instance
   * by the OpenClaw runtime, so this is informational only.
   */
  agentId?: string;
}

export interface WikiRetrievalEngineOptions {
  /** Absolute path to the vault root (e.g. ~/.openclaw/wiki/main). */
  vaultPath: string;
  /** TTL for the in-memory index in ms. Defaults to 60s. */
  refreshIntervalMs?: number;
  /** Injected clock (used by tests for determinism). */
  now?: () => number;
}

export interface WikiRetrievalDiagnostics {
  vaultPath: string;
  vaultExists: boolean;
  indexBuiltAt: number;
  entryCount: number;
}

/** Lightweight YAML frontmatter parser — supports `key: value` scalars and `- value` lists. */
export function parseFrontmatter(raw: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let listKey: string | null = null;
  for (const rawLine of stripBom(raw).split(/\r?\n/)) {
    if (rawLine.length === 0) {
      listKey = null;
      continue;
    }
    if (listKey && /^\s+-\s+/.test(rawLine)) {
      const value = rawLine.replace(/^\s+-\s+/, "").trim();
      const arr = (out[listKey] as unknown[] | undefined) ?? [];
      arr.push(stripQuotes(value));
      out[listKey] = arr;
      continue;
    }
    if (/^\s/.test(rawLine)) {
      // Indented continuation we don't model — keep prior listKey if list,
      // otherwise reset.
      if (!listKey) {
        continue;
      }
      continue;
    }
    listKey = null;
    const colon = rawLine.indexOf(":");
    if (colon === -1) {
      continue;
    }
    const key = rawLine.slice(0, colon).trim();
    const value = rawLine.slice(colon + 1).trim();
    if (key.length === 0) {
      continue;
    }
    if (value.length === 0) {
      out[key] = [];
      listKey = key;
      continue;
    }
    out[key] = stripQuotes(value);
  }
  return out;
}

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value.charAt(0);
    const last = value.charAt(value.length - 1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function deriveId(frontmatter: Record<string, unknown>, relativePath: string): string {
  const explicit = frontmatter.id;
  if (typeof explicit === "string" && explicit.trim().length > 0) {
    return explicit.trim();
  }
  return relativePath.replace(/\.md$/, "").replace(/[\\/]/g, ".");
}

function deriveTitle(frontmatter: Record<string, unknown>, relativePath: string): string {
  const explicit = frontmatter.title;
  if (typeof explicit === "string" && explicit.trim().length > 0) {
    return explicit.trim();
  }
  return relativePath.replace(/\.md$/, "");
}

function deriveStatus(frontmatter: Record<string, unknown>): string {
  const explicit = frontmatter.status;
  if (typeof explicit === "string" && explicit.trim().length > 0) {
    return explicit.trim().toLowerCase();
  }
  return "active";
}

function deriveTags(frontmatter: Record<string, unknown>): string[] {
  const raw = frontmatter.tags;
  if (!Array.isArray(raw)) return [];
  return raw.filter((t): t is string => typeof t === "string" && t.length > 0);
}

function estimateBodyTokens(body: string): number {
  return Math.ceil(body.length / 4);
}

/** Recursively walk the vault for `.md` files, skipping hidden and underscore-prefixed dirs. */
function walkMarkdownFiles(root: string): string[] {
  const results: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name.startsWith("_")) {
        continue;
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && full.toLowerCase().endsWith(".md")) {
        results.push(full);
      }
    }
  }
  return results;
}

/** Load a single markdown file into a WikiEntry, returning null on read failure. */
export function loadWikiEntry(absPath: string, vaultRoot: string): WikiEntry | null {
  let raw: string;
  let stats;
  let realPath: string;
  let realVaultRoot: string;
  try {
    realVaultRoot = realpathSync(vaultRoot);
    realPath = realpathSync(absPath);
    const rel = relative(realVaultRoot, realPath);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      return null;
    }
    raw = stripBom(readFileSync(realPath, "utf8"));
    stats = statSync(realPath);
  } catch {
    return null;
  }

  let frontmatter: Record<string, unknown> = {};
  let body = raw;
  const fmMatch = raw.match(FRONTMATTER_RE);
  if (fmMatch) {
    frontmatter = parseFrontmatter(fmMatch[1] ?? "");
    body = raw.slice(fmMatch[0].length);
  }

  const relativePath = relative(realVaultRoot, realPath);
  const kindRaw = frontmatter.kind;
  return {
    id: deriveId(frontmatter, relativePath),
    path: realPath,
    relativePath,
    title: deriveTitle(frontmatter, relativePath),
    kind: typeof kindRaw === "string" ? kindRaw.trim() : "",
    status: deriveStatus(frontmatter),
    tags: deriveTags(frontmatter),
    body: body.trim(),
    bodyTokens: estimateBodyTokens(body),
    modifiedAt: stats.mtime,
  };
}

/**
 * In-memory wiki index with TTL-based refresh. Built once on first
 * `searchWiki()` call, rebuilt when the index is older than
 * `refreshIntervalMs`. Expected vault size is ~1–2k entries; a full scan
 * is sub-100ms for that range.
 */
export class WikiRetrievalEngine {
  private readonly vaultPath: string;
  private readonly refreshIntervalMs: number;
  private readonly now: () => number;
  private indexBuiltAt = 0;
  private entries: WikiEntry[] = [];

  constructor(options: WikiRetrievalEngineOptions) {
    this.vaultPath = options.vaultPath;
    this.refreshIntervalMs = options.refreshIntervalMs ?? DEFAULT_REFRESH_MS;
    this.now = options.now ?? Date.now;
  }

  /** Force the next `searchWiki()` to rebuild the index. Used by tests. */
  invalidate(): void {
    this.indexBuiltAt = 0;
    this.entries = [];
  }

  /** Number of currently indexed entries; triggers a refresh if stale. */
  size(): number {
    this.refreshIfStale();
    return this.entries.length;
  }

  /** Snapshot of internal state for diagnostics / tests. */
  diagnostics(): WikiRetrievalDiagnostics {
    return {
      vaultPath: this.vaultPath,
      vaultExists: existsSync(this.vaultPath),
      indexBuiltAt: this.indexBuiltAt,
      entryCount: this.entries.length,
    };
  }

  /**
   * Score the wiki against `query` and return up to `maxEntries` hits whose
   * formatted token estimate stays under `maxTokens`. Returns [] when the
   * query has no searchable terms or the vault is empty / missing.
   */
  searchWiki(query: string, options: WikiSearchOptions): WikiHit[] {
    if (typeof query !== "string" || tokenizeText(query).length === 0) {
      return [];
    }
    if (
      !Number.isFinite(options.maxEntries) ||
      !Number.isFinite(options.maxTokens) ||
      options.maxEntries <= 0 ||
      options.maxTokens <= 0
    ) {
      return [];
    }
    const maxEntries = Math.floor(options.maxEntries);
    const maxTokens = Math.floor(options.maxTokens);
    this.refreshIfStale();
    if (this.entries.length === 0) {
      return [];
    }

    const candidates: WikiHit[] = [];
    for (const entry of this.entries) {
      if (NON_ACTIVE_STATUSES.has(entry.status)) {
        continue;
      }
      const titleScore = scoreRelevance(entry.title, query) * TITLE_BOOST;
      const tagsScore = scoreRelevance(entry.tags.join(" "), query) * TAGS_BOOST;
      const kindScore = scoreRelevance(entry.kind, query) * KIND_BOOST;
      const bodyScore = scoreRelevance(entry.body, query);
      const score = titleScore + tagsScore + kindScore + bodyScore;
      if (score > 0) {
        candidates.push({ entry, score });
      }
    }

    candidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.entry.modifiedAt.getTime() - a.entry.modifiedAt.getTime();
    });

    const selected: WikiHit[] = [];
    let tokenAccum = 0;
    for (const candidate of candidates) {
      if (selected.length >= maxEntries) break;
      const projected =
        (selected.length === 0 ? WIKI_WRAPPER_TOKEN_OVERHEAD : tokenAccum) +
        WIKI_ENTRY_TOKEN_OVERHEAD +
        candidate.entry.bodyTokens;
      if (projected > maxTokens) continue;
      selected.push(candidate);
      tokenAccum = projected;
    }
    return selected;
  }

  private refreshIfStale(): void {
    const now = this.now();
    if (this.indexBuiltAt > 0 && now - this.indexBuiltAt < this.refreshIntervalMs) {
      return;
    }
    if (!existsSync(this.vaultPath)) {
      this.entries = [];
      this.indexBuiltAt = now;
      return;
    }
    const paths = walkMarkdownFiles(this.vaultPath);
    const entries: WikiEntry[] = [];
    for (const p of paths) {
      const entry = loadWikiEntry(p, this.vaultPath);
      if (entry) entries.push(entry);
    }
    this.entries = entries;
    this.indexBuiltAt = now;
  }
}

/** XML-encode a value for attribute use. */
function escapeAttr(value: string): string {
  return escapeText(value)
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** XML-encode text content. */
function escapeText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Format wiki hits into a single content string suitable for injection as a
 * synthetic user message at the head of assembled context. Uses a
 * `<wiki-canon>` wrapper so the model can distinguish reference knowledge
 * from conversation history.
 */
export function formatWikiHits(hits: readonly WikiHit[]): string {
  if (hits.length === 0) return "";
  const lines: string[] = [];
  lines.push("<wiki-canon>");
  lines.push("  <preamble>");
  lines.push("    Reference knowledge from your local wiki canon — curated decisions,");
  lines.push("    syntheses, and policies. These entries are NOT conversation history;");
  lines.push("    treat them as static knowledge and cite by id when used.");
  lines.push("  </preamble>");
  for (const hit of hits) {
    const attrs: string[] = [`id="${escapeAttr(hit.entry.id)}"`];
    if (hit.entry.title) attrs.push(`title="${escapeAttr(hit.entry.title)}"`);
    if (hit.entry.kind) attrs.push(`kind="${escapeAttr(hit.entry.kind)}"`);
    if (hit.entry.tags.length > 0) {
      attrs.push(`tags="${escapeAttr(hit.entry.tags.join(","))}"`);
    }
    lines.push(`  <entry ${attrs.join(" ")}>`);
    for (const bodyLine of hit.entry.body.split(/\r?\n/)) {
      lines.push(`    ${escapeText(bodyLine)}`);
    }
    lines.push("  </entry>");
  }
  lines.push("</wiki-canon>");
  return lines.join("\n");
}

/** Total body tokens across hits, plus a small fixed wrapper overhead. */
export function sumWikiTokens(hits: readonly WikiHit[]): number {
  if (hits.length === 0) return 0;
  let total = WIKI_WRAPPER_TOKEN_OVERHEAD;
  for (const hit of hits) {
    total += hit.entry.bodyTokens;
    total += WIKI_ENTRY_TOKEN_OVERHEAD;
  }
  return total;
}
