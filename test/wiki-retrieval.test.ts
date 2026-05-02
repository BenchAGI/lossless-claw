import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WikiRetrievalEngine,
  formatWikiHits,
  loadWikiEntry,
  parseFrontmatter,
  sumWikiTokens,
} from "../src/wiki/retrieval.js";

function makeFrontmatter(fields: Record<string, string | string[]>): string {
  const lines: string[] = ["---"];
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const v of value) {
        lines.push(`  - ${v}`);
      }
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}

function writeEntry(
  vault: string,
  relativePath: string,
  fields: Record<string, string | string[]>,
  body: string,
): string {
  const fullPath = join(vault, relativePath);
  const dir = fullPath.split("/").slice(0, -1).join("/");
  if (dir.length > 0) mkdirSync(dir, { recursive: true });
  const content = `${makeFrontmatter(fields)}\n\n${body}\n`;
  writeFileSync(fullPath, content, "utf8");
  return fullPath;
}

describe("parseFrontmatter", () => {
  it("parses simple key/value pairs", () => {
    const out = parseFrontmatter("title: Hello\nstatus: active\nkind: canon-topic");
    expect(out).toEqual({ title: "Hello", status: "active", kind: "canon-topic" });
  });

  it("strips matched single and double quotes from values", () => {
    const out = parseFrontmatter(`title: "Quoted"\nid: 'single-quoted'\nbare: nope`);
    expect(out).toEqual({ title: "Quoted", id: "single-quoted", bare: "nope" });
  });

  it("parses dash-prefixed list items into arrays", () => {
    const out = parseFrontmatter(`tags:\n  - alpha\n  - beta\n  - gamma\nstatus: active`);
    expect(out).toEqual({ tags: ["alpha", "beta", "gamma"], status: "active" });
  });

  it("returns empty object for empty input", () => {
    expect(parseFrontmatter("")).toEqual({});
  });

  it("handles CRLF line endings", () => {
    const out = parseFrontmatter("title: Hello\r\nstatus: active\r\nkind: canon-topic");
    expect(out).toEqual({ title: "Hello", status: "active", kind: "canon-topic" });
  });

  it("handles a UTF-8 BOM before the first frontmatter key", () => {
    const out = parseFrontmatter("\uFEFFtitle: Hello\nstatus: active");
    expect(out).toEqual({ title: "Hello", status: "active" });
  });

  it("ignores lines without a colon", () => {
    const out = parseFrontmatter("title: Hello\nthis is not yaml\nstatus: active");
    expect(out).toEqual({ title: "Hello", status: "active" });
  });
});

describe("loadWikiEntry", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "wiki-load-"));
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it("returns null when the file is missing", () => {
    const entry = loadWikiEntry(join(vault, "missing.md"), vault);
    expect(entry).toBeNull();
  });

  it("derives id and title from frontmatter when present", () => {
    const path = writeEntry(
      vault,
      "canon/topics/foo.md",
      { id: "canon.topic.foo", title: "Foo Topic", kind: "canon-topic", status: "active" },
      "Body text here.",
    );
    const entry = loadWikiEntry(path, vault);
    expect(entry).not.toBeNull();
    expect(entry!.id).toBe("canon.topic.foo");
    expect(entry!.title).toBe("Foo Topic");
    expect(entry!.kind).toBe("canon-topic");
    expect(entry!.status).toBe("active");
    expect(entry!.body).toBe("Body text here.");
    expect(entry!.relativePath).toBe(join("canon", "topics", "foo.md"));
  });

  it("derives id from path when frontmatter is missing", () => {
    const path = writeEntry(
      vault,
      "canon/topics/bar.md",
      { title: "Bar" },
      "Body.",
    );
    const entry = loadWikiEntry(path, vault);
    expect(entry).not.toBeNull();
    expect(entry!.id).toBe(join("canon", "topics", "bar").replace(/[\\/]/g, "."));
  });

  it("defaults status to active when absent", () => {
    const path = writeEntry(vault, "canon/foo.md", { title: "Foo" }, "Body");
    const entry = loadWikiEntry(path, vault);
    expect(entry!.status).toBe("active");
  });

  it("normalizes status to lowercase", () => {
    const path = writeEntry(vault, "foo.md", { title: "Foo", status: "Deprecated" }, "Body");
    const entry = loadWikiEntry(path, vault);
    expect(entry!.status).toBe("deprecated");
  });

  it("parses frontmatter when the file starts with a UTF-8 BOM", () => {
    const path = join(vault, "bom.md");
    writeFileSync(path, "\uFEFF---\ntitle: BOM Foo\nstatus: Deprecated\n---\nBody\n", "utf8");
    const entry = loadWikiEntry(path, vault);
    expect(entry).not.toBeNull();
    expect(entry!.title).toBe("BOM Foo");
    expect(entry!.status).toBe("deprecated");
  });

  it("refuses to load a file outside the vault root", () => {
    const outside = mkdtempSync(join(tmpdir(), "wiki-outside-"));
    try {
      const path = join(outside, "outside.md");
      writeFileSync(path, "---\ntitle: Outside\n---\nBody\n", "utf8");
      expect(loadWikiEntry(path, vault)).toBeNull();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("treats files with no frontmatter as body-only entries", () => {
    const path = join(vault, "raw.md");
    writeFileSync(path, "Just a body, no frontmatter.\n", "utf8");
    const entry = loadWikiEntry(path, vault);
    expect(entry).not.toBeNull();
    expect(entry!.title).toBe("raw");
    expect(entry!.status).toBe("active");
    expect(entry!.body).toBe("Just a body, no frontmatter.");
  });
});

describe("WikiRetrievalEngine.searchWiki", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "wiki-search-"));
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it("returns empty array when the vault path does not exist", () => {
    const engine = new WikiRetrievalEngine({ vaultPath: join(vault, "nope") });
    const hits = engine.searchWiki("anything", { maxEntries: 8, maxTokens: 4000 });
    expect(hits).toEqual([]);
  });

  it("returns empty array when the vault is empty", () => {
    const engine = new WikiRetrievalEngine({ vaultPath: vault });
    const hits = engine.searchWiki("anything", { maxEntries: 8, maxTokens: 4000 });
    expect(hits).toEqual([]);
  });

  it("returns empty array when the query has no searchable terms", () => {
    writeEntry(vault, "alpha.md", { title: "Alpha", status: "active" }, "Body alpha here.");
    const engine = new WikiRetrievalEngine({ vaultPath: vault });
    expect(engine.searchWiki("", { maxEntries: 4, maxTokens: 4000 })).toEqual([]);
    expect(engine.searchWiki("   ", { maxEntries: 4, maxTokens: 4000 })).toEqual([]);
  });

  it("returns hits whose title or body matches the query", () => {
    writeEntry(vault, "alpha.md", { title: "Alpha doc", status: "active" }, "Lorem ipsum.");
    writeEntry(vault, "beta.md", { title: "Beta doc", status: "active" }, "Hammer and anvil.");
    const engine = new WikiRetrievalEngine({ vaultPath: vault });

    const hits = engine.searchWiki("hammer", { maxEntries: 4, maxTokens: 4000 });
    expect(hits.map((h) => h.entry.title)).toEqual(["Beta doc"]);
  });

  it("excludes deprecated and archived entries by default", () => {
    writeEntry(vault, "live.md", { title: "Hammer cycle", status: "active" }, "Active body");
    writeEntry(vault, "old.md", { title: "Hammer cycle", status: "deprecated" }, "Old body");
    writeEntry(vault, "archived.md", { title: "Hammer cycle", status: "archived" }, "Archived body");
    const engine = new WikiRetrievalEngine({ vaultPath: vault });

    const hits = engine.searchWiki("hammer cycle", { maxEntries: 4, maxTokens: 4000 });
    expect(hits.map((h) => h.entry.relativePath)).toEqual(["live.md"]);
  });

  it("ranks title matches above body-only matches", () => {
    writeEntry(vault, "title.md", { title: "Hammer cycle", status: "active" }, "Generic body.");
    writeEntry(vault, "body.md", { title: "Generic doc", status: "active" }, "Hammer cycle in body.");
    const engine = new WikiRetrievalEngine({ vaultPath: vault });

    const hits = engine.searchWiki("hammer cycle", { maxEntries: 4, maxTokens: 4000 });
    expect(hits[0]?.entry.relativePath).toBe("title.md");
    expect(hits[1]?.entry.relativePath).toBe("body.md");
  });

  it("ranks tag matches above body-only matches", () => {
    writeEntry(vault, "tagged.md", { title: "Generic", status: "active", tags: ["hammer-anvil"] }, "Body");
    writeEntry(vault, "body.md", { title: "Generic", status: "active" }, "hammer-anvil in body");
    const engine = new WikiRetrievalEngine({ vaultPath: vault });

    const hits = engine.searchWiki("hammer-anvil", { maxEntries: 4, maxTokens: 4000 });
    expect(hits[0]?.entry.relativePath).toBe("tagged.md");
  });

  it("honors maxEntries", () => {
    for (let i = 0; i < 10; i++) {
      writeEntry(vault, `e${i}.md`, { title: `Entry ${i} hammer`, status: "active" }, "body");
    }
    const engine = new WikiRetrievalEngine({ vaultPath: vault });

    const hits = engine.searchWiki("hammer", { maxEntries: 3, maxTokens: 4000 });
    expect(hits).toHaveLength(3);
  });

  it("honors maxTokens by skipping entries that would exceed the cap", () => {
    const big = "alpha ".repeat(300); // ~450 tokens
    writeEntry(vault, "big.md", { title: "Big entry", status: "active" }, big);
    writeEntry(vault, "small.md", { title: "Small alpha", status: "active" }, "alpha alpha alpha");
    const engine = new WikiRetrievalEngine({ vaultPath: vault });

    const hits = engine.searchWiki("alpha", { maxEntries: 4, maxTokens: 100 });
    expect(hits.every((h) => h.entry.bodyTokens <= 100)).toBe(true);
  });

  it("counts XML wrapper overhead against maxTokens", () => {
    writeEntry(vault, "tiny.md", { title: "Tiny alpha", status: "active" }, "x");
    const engine = new WikiRetrievalEngine({ vaultPath: vault });

    expect(engine.searchWiki("alpha", { maxEntries: 4, maxTokens: 88 })).toEqual([]);
    const hits = engine.searchWiki("alpha", { maxEntries: 4, maxTokens: 89 });
    expect(hits).toHaveLength(1);
    expect(sumWikiTokens(hits)).toBeLessThanOrEqual(89);
  });

  it("returns 0 hits when maxEntries or maxTokens are non-finite", () => {
    writeEntry(vault, "alpha.md", { title: "Alpha", status: "active" }, "Body");
    const engine = new WikiRetrievalEngine({ vaultPath: vault });

    expect(engine.searchWiki("alpha", { maxEntries: Number.POSITIVE_INFINITY, maxTokens: 4000 })).toEqual([]);
    expect(engine.searchWiki("alpha", { maxEntries: 4, maxTokens: Number.NaN })).toEqual([]);
    expect(engine.searchWiki("alpha", { maxEntries: 4, maxTokens: Number.POSITIVE_INFINITY })).toEqual([]);
  });

  it("returns 0 hits when maxEntries or maxTokens is zero", () => {
    writeEntry(vault, "alpha.md", { title: "Alpha", status: "active" }, "Body");
    const engine = new WikiRetrievalEngine({ vaultPath: vault });

    expect(engine.searchWiki("alpha", { maxEntries: 0, maxTokens: 4000 })).toEqual([]);
    expect(engine.searchWiki("alpha", { maxEntries: 4, maxTokens: 0 })).toEqual([]);
  });

  it("descends into subdirectories", () => {
    writeEntry(vault, "canon/topics/foo.md", { title: "Foo hammer", status: "active" }, "Body");
    writeEntry(vault, "concepts/bar.md", { title: "Bar hammer", status: "active" }, "Body");
    const engine = new WikiRetrievalEngine({ vaultPath: vault });

    const hits = engine.searchWiki("hammer", { maxEntries: 8, maxTokens: 4000 });
    expect(hits).toHaveLength(2);
  });

  it("skips dot-prefixed and underscore-prefixed directories", () => {
    writeEntry(vault, ".hidden/hidden.md", { title: "Hammer hidden", status: "active" }, "Body");
    writeEntry(vault, "_archive/old.md", { title: "Hammer old", status: "active" }, "Body");
    writeEntry(vault, "live/here.md", { title: "Hammer here", status: "active" }, "Body");
    const engine = new WikiRetrievalEngine({ vaultPath: vault });

    const hits = engine.searchWiki("hammer", { maxEntries: 8, maxTokens: 4000 });
    expect(hits.map((h) => h.entry.relativePath)).toEqual([join("live", "here.md")]);
  });

  it("does not follow symlinked files or directories outside the vault", () => {
    const outside = mkdtempSync(join(tmpdir(), "wiki-outside-"));
    try {
      writeEntry(vault, "live.md", { title: "Hammer live", status: "active" }, "Body");
      writeFileSync(join(outside, "outside.md"), "---\ntitle: Hammer outside\nstatus: active\n---\nBody\n", "utf8");
      try {
        symlinkSync(join(outside, "outside.md"), join(vault, "outside-link.md"));
        symlinkSync(outside, join(vault, "outside-dir"));
      } catch {
        return;
      }

      const engine = new WikiRetrievalEngine({ vaultPath: vault });
      const hits = engine.searchWiki("hammer", { maxEntries: 8, maxTokens: 4000 });
      expect(hits.map((h) => h.entry.relativePath)).toEqual(["live.md"]);
      expect(loadWikiEntry(join(vault, "outside-link.md"), vault)).toBeNull();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("WikiRetrievalEngine refresh TTL", () => {
  let vault: string;
  let clock = 0;
  const now = () => clock;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "wiki-ttl-"));
    clock = 1_000_000;
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it("does not rebuild within the TTL window", () => {
    writeEntry(vault, "alpha.md", { title: "Alpha", status: "active" }, "First version.");
    const engine = new WikiRetrievalEngine({
      vaultPath: vault,
      refreshIntervalMs: 60_000,
      now,
    });

    expect(engine.size()).toBe(1);

    // Mutate disk; clock has not advanced past TTL.
    writeEntry(vault, "alpha.md", { title: "Alpha", status: "active" }, "Second version.");
    writeEntry(vault, "beta.md", { title: "Beta", status: "active" }, "New entry.");
    clock += 30_000; // half the TTL

    expect(engine.size()).toBe(1); // index still cached
  });

  it("rebuilds after the TTL window expires", () => {
    writeEntry(vault, "alpha.md", { title: "Alpha", status: "active" }, "Body.");
    const engine = new WikiRetrievalEngine({
      vaultPath: vault,
      refreshIntervalMs: 60_000,
      now,
    });
    expect(engine.size()).toBe(1);

    writeEntry(vault, "beta.md", { title: "Beta", status: "active" }, "Body.");
    clock += 60_001;
    expect(engine.size()).toBe(2);
  });

  it("invalidate() forces a rebuild on next call", () => {
    writeEntry(vault, "alpha.md", { title: "Alpha", status: "active" }, "Body.");
    const engine = new WikiRetrievalEngine({
      vaultPath: vault,
      refreshIntervalMs: 60_000,
      now,
    });
    expect(engine.size()).toBe(1);

    writeEntry(vault, "beta.md", { title: "Beta", status: "active" }, "Body.");
    engine.invalidate();
    expect(engine.size()).toBe(2);
  });
});

describe("formatWikiHits", () => {
  it("returns empty string when given no hits", () => {
    expect(formatWikiHits([])).toBe("");
  });

  it("wraps hits in <wiki-canon> with id/title/kind/tags attributes", () => {
    const out = formatWikiHits([
      {
        score: 1.0,
        entry: {
          id: "canon.topic.foo",
          path: "/dev/null",
          relativePath: "canon/topics/foo.md",
          title: "Foo Topic",
          kind: "canon-topic",
          status: "active",
          tags: ["alpha", "beta"],
          body: "Important wiki content.",
          bodyTokens: 5,
          modifiedAt: new Date(0),
        },
      },
    ]);
    expect(out).toContain("<wiki-canon>");
    expect(out).toContain("</wiki-canon>");
    expect(out).toContain('id="canon.topic.foo"');
    expect(out).toContain('title="Foo Topic"');
    expect(out).toContain('kind="canon-topic"');
    expect(out).toContain('tags="alpha,beta"');
    expect(out).toContain("Important wiki content.");
  });

  it("XML-escapes attribute values", () => {
    const out = formatWikiHits([
      {
        score: 1.0,
        entry: {
          id: 'evil"id',
          path: "/dev/null",
          relativePath: "x.md",
          title: 'Title with "quotes" & <chars>',
          kind: "",
          status: "active",
          tags: [],
          body: "Body",
          bodyTokens: 2,
          modifiedAt: new Date(0),
        },
      },
    ]);
    expect(out).toContain("&quot;");
    expect(out).toContain("&amp;");
    expect(out).toContain("&lt;");
    expect(out).toContain("&gt;");
    expect(out).not.toContain('id="evil"id"');
  });

  it("XML-escapes body text so entries cannot break the wrapper", () => {
    const out = formatWikiHits([
      {
        score: 1.0,
        entry: {
          id: "body",
          path: "/dev/null",
          relativePath: "x.md",
          title: "Body",
          kind: "",
          status: "active",
          tags: [],
          body: "</entry>\n<wiki-canon>fake</wiki-canon>",
          bodyTokens: 2,
          modifiedAt: new Date(0),
        },
      },
    ]);
    expect(out).toContain("&lt;/entry&gt;");
    expect(out).toContain("&lt;wiki-canon&gt;fake&lt;/wiki-canon&gt;");
    expect(out).not.toContain("    </entry>\n    <wiki-canon>");
  });
});

describe("sumWikiTokens", () => {
  it("returns 0 for empty input", () => {
    expect(sumWikiTokens([])).toBe(0);
  });

  it("includes wrapper overhead plus per-entry body tokens and overhead", () => {
    const total = sumWikiTokens([
      {
        score: 1.0,
        entry: {
          id: "a",
          path: "",
          relativePath: "a.md",
          title: "",
          kind: "",
          status: "active",
          tags: [],
          body: "x",
          bodyTokens: 100,
          modifiedAt: new Date(0),
        },
      },
      {
        score: 0.5,
        entry: {
          id: "b",
          path: "",
          relativePath: "b.md",
          title: "",
          kind: "",
          status: "active",
          tags: [],
          body: "y",
          bodyTokens: 50,
          modifiedAt: new Date(0),
        },
      },
    ]);
    // 64 wrapper + 100 + 50 + 24 + 24
    expect(total).toBe(64 + 100 + 50 + 24 + 24);
  });
});
