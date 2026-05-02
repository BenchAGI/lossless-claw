import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { ContextAssembler } from "../src/assembler.js";
import type { LcmConfig } from "../src/db/config.js";
import { createLcmDatabaseConnection } from "../src/db/connection.js";
import { LcmContextEngine } from "../src/engine.js";
import type { LcmDependencies } from "../src/types.js";
import { WikiRetrievalEngine } from "../src/wiki/retrieval.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  }
});

function createTestConfig(databasePath: string): LcmConfig {
  return {
    enabled: true,
    databasePath,
    largeFilesDir: join(databasePath, "..", "lcm-files"),
    ignoreSessionPatterns: [],
    statelessSessionPatterns: [],
    skipStatelessSessions: true,
    contextThreshold: 0.75,
    freshTailCount: 8,
    promptAwareEviction: false,
    newSessionRetainDepth: 2,
    leafMinFanout: 8,
    condensedMinFanout: 4,
    condensedMinFanoutHard: 2,
    incrementalMaxDepth: 0,
    leafChunkTokens: 20_000,
    leafTargetTokens: 600,
    condensedTargetTokens: 900,
    maxExpandTokens: 4000,
    largeFileTokenThreshold: 25_000,
    summaryProvider: "",
    summaryModel: "",
    largeFileSummaryProvider: "",
    largeFileSummaryModel: "",
    expansionProvider: "",
    expansionModel: "",
    delegationTimeoutMs: 120_000,
    summaryTimeoutMs: 60_000,
    timezone: "UTC",
    pruneHeartbeatOk: false,
    transcriptGcEnabled: false,
    proactiveThresholdCompactionMode: "deferred",
    summaryMaxOverageFactor: 3,
    customInstructions: "",
    circuitBreakerThreshold: 5,
    circuitBreakerCooldownMs: 1_800_000,
    fallbackProviders: [],
    cacheAwareCompaction: {
      enabled: true,
      cacheTTLSeconds: 300,
      maxColdCacheCatchupPasses: 2,
      hotCachePressureFactor: 4,
      hotCacheBudgetHeadroomRatio: 0.2,
      coldCacheObservationThreshold: 3,
    },
    dynamicLeafChunkTokens: {
      enabled: true,
      max: 40_000,
    },
    wikiEnabled: false,
    wikiVaultPath: join(databasePath, "..", "wiki", "main"),
    wikiBudgetFraction: 0.30,
    wikiMaxTokens: 8000,
    wikiMaxEntries: 8,
    wikiRefreshIntervalMs: 60_000,
  };
}

function createTestDeps(config: LcmConfig): LcmDependencies {
  return {
    config,
    complete: vi.fn(async () => ({
      content: [{ type: "text", text: "summary output" }],
    })),
    callGateway: vi.fn(async () => ({})),
    resolveModel: vi.fn(() => ({ provider: "anthropic", model: "claude-opus-4-5" })),
    getApiKey: vi.fn(async () => process.env.ANTHROPIC_API_KEY),
    requireApiKey: vi.fn(async () => process.env.ANTHROPIC_API_KEY ?? "test-api-key"),
    parseAgentSessionKey: () => null,
    isSubagentSessionKey: () => false,
    normalizeAgentId: (id?: string) => (id?.trim() ? id : "main"),
    buildSubagentSystemPrompt: () => "subagent prompt",
    readLatestAssistantReply: () => undefined,
    log: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  } as unknown as LcmDependencies;
}

function createEngine(): { engine: LcmContextEngine; vaultPath: string; tempDir: string } {
  const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-wiki-"));
  tempDirs.push(tempDir);
  const vaultPath = join(tempDir, "wiki", "main");
  mkdirSync(vaultPath, { recursive: true });
  const config = createTestConfig(join(tempDir, "lcm.db"));
  const db = createLcmDatabaseConnection(config.databasePath);
  const engine = new LcmContextEngine(createTestDeps(config), db);
  return { engine, vaultPath, tempDir };
}

function makeMessage(params: { role?: string; content: unknown }): AgentMessage {
  return {
    role: (params.role ?? "assistant") as AgentMessage["role"],
    content: params.content,
    timestamp: Date.now(),
  } as AgentMessage;
}

function writeWikiEntry(
  vault: string,
  relativePath: string,
  fields: Record<string, string>,
  body: string,
): void {
  const fullPath = join(vault, relativePath);
  const dir = fullPath.split("/").slice(0, -1).join("/");
  if (dir.length > 0) mkdirSync(dir, { recursive: true });
  const fmLines = ["---"];
  for (const [k, v] of Object.entries(fields)) {
    fmLines.push(`${k}: ${v}`);
  }
  fmLines.push("---");
  writeFileSync(fullPath, `${fmLines.join("\n")}\n\n${body}\n`, "utf8");
}

function getMessageContentAsString(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type?: string; text?: string } => !!b && typeof b === "object")
      .map((b) => (b.type === "text" && typeof b.text === "string" ? b.text : ""))
      .join("");
  }
  return "";
}

describe("ContextAssembler wiki injection", () => {
  it("does not inject wiki when no wiki engine is configured", async () => {
    const { engine } = createEngine();
    const sessionId = randomUUID();
    await engine.ingest({
      sessionId,
      message: makeMessage({ role: "user", content: "tell me about hammer-anvil" }),
    });
    await engine.ingest({
      sessionId,
      message: makeMessage({ role: "assistant", content: "sure thing" }),
    });

    const conversation = await engine
      .getConversationStore()
      .getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    // No 4th arg = no wiki engine.
    const assembler = new ContextAssembler(
      engine.getConversationStore(),
      engine.getSummaryStore(),
    );
    const result = await assembler.assemble({
      conversationId: conversation!.conversationId,
      tokenBudget: 10_000,
      prompt: "hammer anvil cycle",
      wikiBudget: 4000,
    });

    expect(result.debug?.wikiHitCount ?? 0).toBe(0);
    expect(result.debug?.wikiTokens ?? 0).toBe(0);
    expect(result.messages.length).toBeGreaterThan(0);
    const head = getMessageContentAsString(result.messages[0]);
    expect(head).not.toContain("<wiki-canon>");
  });

  it("injects wiki content at head when engine + prompt + budget all set", async () => {
    const { engine, vaultPath } = createEngine();
    writeWikiEntry(
      vaultPath,
      "canon/topics/hammer-anvil-cycle.md",
      { id: "canon.hammer-anvil", title: "Hammer/Anvil cycle", kind: "canon-topic", status: "active" },
      "The Hammer/Anvil cycle pairs Claude (hammer) with Codex (anvil) for verified PRs.",
    );

    const sessionId = randomUUID();
    await engine.ingest({
      sessionId,
      message: makeMessage({ role: "user", content: "what's the hammer anvil cycle?" }),
    });
    await engine.ingest({
      sessionId,
      message: makeMessage({ role: "assistant", content: "let me think" }),
    });

    const conversation = await engine
      .getConversationStore()
      .getConversationBySessionId(sessionId);
    const wikiEngine = new WikiRetrievalEngine({ vaultPath, refreshIntervalMs: 0 });

    const assembler = new ContextAssembler(
      engine.getConversationStore(),
      engine.getSummaryStore(),
      "UTC",
      wikiEngine,
    );
    const result = await assembler.assemble({
      conversationId: conversation!.conversationId,
      tokenBudget: 10_000,
      prompt: "hammer anvil cycle",
      wikiBudget: 4000,
    });

    expect(result.debug?.wikiHitCount).toBe(1);
    expect(result.debug?.wikiTokens ?? 0).toBeGreaterThan(0);
    expect(result.messages.length).toBeGreaterThan(0);
    const head = getMessageContentAsString(result.messages[0]);
    expect(head).toContain("<wiki-canon>");
    expect(head).toContain('id="canon.hammer-anvil"');
    expect(head).toContain("Hammer/Anvil cycle pairs Claude");
  });

  it("does not inject wiki when prompt is missing", async () => {
    const { engine, vaultPath } = createEngine();
    writeWikiEntry(
      vaultPath,
      "canon/topics/hammer-anvil-cycle.md",
      { title: "Hammer/Anvil cycle", status: "active" },
      "Body about hammer anvil.",
    );
    const sessionId = randomUUID();
    await engine.ingest({
      sessionId,
      message: makeMessage({ role: "user", content: "hi" }),
    });
    await engine.ingest({
      sessionId,
      message: makeMessage({ role: "assistant", content: "hello" }),
    });
    const conversation = await engine
      .getConversationStore()
      .getConversationBySessionId(sessionId);
    const wikiEngine = new WikiRetrievalEngine({ vaultPath, refreshIntervalMs: 0 });

    const assembler = new ContextAssembler(
      engine.getConversationStore(),
      engine.getSummaryStore(),
      "UTC",
      wikiEngine,
    );

    // Missing prompt:
    const noPrompt = await assembler.assemble({
      conversationId: conversation!.conversationId,
      tokenBudget: 10_000,
      wikiBudget: 4000,
    });
    expect(noPrompt.debug?.wikiHitCount).toBe(0);
    expect(noPrompt.debug?.wikiTokens).toBe(0);

    // Empty prompt:
    const emptyPrompt = await assembler.assemble({
      conversationId: conversation!.conversationId,
      tokenBudget: 10_000,
      prompt: "   ",
      wikiBudget: 4000,
    });
    expect(emptyPrompt.debug?.wikiHitCount).toBe(0);
  });

  it("does not inject wiki when wikiBudget is zero", async () => {
    const { engine, vaultPath } = createEngine();
    writeWikiEntry(
      vaultPath,
      "topic.md",
      { title: "Hammer cycle", status: "active" },
      "Body about hammer cycle and anvil.",
    );
    const sessionId = randomUUID();
    await engine.ingest({
      sessionId,
      message: makeMessage({ role: "user", content: "hammer" }),
    });
    await engine.ingest({
      sessionId,
      message: makeMessage({ role: "assistant", content: "ok" }),
    });
    const conversation = await engine
      .getConversationStore()
      .getConversationBySessionId(sessionId);
    const wikiEngine = new WikiRetrievalEngine({ vaultPath, refreshIntervalMs: 0 });

    const assembler = new ContextAssembler(
      engine.getConversationStore(),
      engine.getSummaryStore(),
      "UTC",
      wikiEngine,
    );
    const result = await assembler.assemble({
      conversationId: conversation!.conversationId,
      tokenBudget: 10_000,
      prompt: "hammer cycle",
      wikiBudget: 0,
    });
    expect(result.debug?.wikiHitCount).toBe(0);
    expect(result.debug?.wikiTokens).toBe(0);
  });

  it("subtracts wiki tokens from the LCM budget so the combined prompt fits", async () => {
    const { engine, vaultPath } = createEngine();
    writeWikiEntry(
      vaultPath,
      "topic.md",
      { title: "Hammer Anvil cycle", status: "active" },
      "alpha ".repeat(200),
    );
    const sessionId = randomUUID();
    for (let i = 0; i < 6; i++) {
      await engine.ingest({
        sessionId,
        message: makeMessage({ role: i % 2 === 0 ? "user" : "assistant", content: `turn ${i} hammer ` }),
      });
    }
    const conversation = await engine
      .getConversationStore()
      .getConversationBySessionId(sessionId);
    const wikiEngine = new WikiRetrievalEngine({ vaultPath, refreshIntervalMs: 0 });

    const assembler = new ContextAssembler(
      engine.getConversationStore(),
      engine.getSummaryStore(),
      "UTC",
      wikiEngine,
    );
    const totalBudget = 5000;
    const wikiBudget = 1500;
    const result = await assembler.assemble({
      conversationId: conversation!.conversationId,
      tokenBudget: totalBudget,
      prompt: "hammer anvil",
      wikiBudget,
    });

    expect(result.debug?.wikiHitCount).toBe(1);
    const wikiTokens = result.debug!.wikiTokens;
    const lcmBudget = result.debug!.lcmBudget;
    expect(wikiTokens).toBeGreaterThan(0);
    expect(wikiTokens).toBeLessThanOrEqual(wikiBudget);
    expect(lcmBudget).toBe(totalBudget - wikiTokens);
    // Combined estimated tokens stays within total budget (since LCM ran with reduced budget).
    expect(result.estimatedTokens).toBeLessThanOrEqual(totalBudget);
  });

  it("does not inject wiki when wrapper overhead cannot fit the available budget", async () => {
    const { engine, vaultPath } = createEngine();
    writeWikiEntry(
      vaultPath,
      "tiny.md",
      { title: "Tiny hammer", status: "active" },
      "x",
    );
    const sessionId = randomUUID();
    await engine.ingest({
      sessionId,
      message: makeMessage({ role: "user", content: "hammer" }),
    });
    await engine.ingest({
      sessionId,
      message: makeMessage({ role: "assistant", content: "ok" }),
    });
    const conversation = await engine
      .getConversationStore()
      .getConversationBySessionId(sessionId);
    const wikiEngine = new WikiRetrievalEngine({ vaultPath, refreshIntervalMs: 0 });

    const assembler = new ContextAssembler(
      engine.getConversationStore(),
      engine.getSummaryStore(),
      "UTC",
      wikiEngine,
    );
    const result = await assembler.assemble({
      conversationId: conversation!.conversationId,
      tokenBudget: 88,
      prompt: "hammer",
      wikiBudget: 88,
    });

    expect(result.debug?.wikiHitCount).toBe(0);
    expect(result.debug?.wikiTokens).toBe(0);
    expect(result.estimatedTokens).toBeLessThanOrEqual(88);
  });

  it("does not let wiki consume budget reserved by the protected fresh tail", async () => {
    const { engine, vaultPath } = createEngine();
    writeWikiEntry(
      vaultPath,
      "tiny.md",
      { title: "Tiny hammer", status: "active" },
      "x",
    );
    const sessionId = randomUUID();
    await engine.ingest({
      sessionId,
      message: makeMessage({ role: "user", content: "hammer " + "tail ".repeat(280) }),
    });
    await engine.ingest({
      sessionId,
      message: makeMessage({ role: "assistant", content: "ok" }),
    });
    const conversation = await engine
      .getConversationStore()
      .getConversationBySessionId(sessionId);
    const wikiEngine = new WikiRetrievalEngine({ vaultPath, refreshIntervalMs: 0 });

    const assembler = new ContextAssembler(
      engine.getConversationStore(),
      engine.getSummaryStore(),
      "UTC",
      wikiEngine,
    );
    const result = await assembler.assemble({
      conversationId: conversation!.conversationId,
      tokenBudget: 120,
      prompt: "hammer",
      wikiBudget: 120,
    });

    expect(result.debug?.tailTokens ?? 0).toBeGreaterThan(31);
    expect(result.debug?.wikiHitCount).toBe(0);
    expect(result.debug?.wikiTokens).toBe(0);
  });

  it("returns no hits when the vault is empty even with prompt + budget set", async () => {
    const { engine, vaultPath } = createEngine();
    // No entries written.
    const sessionId = randomUUID();
    await engine.ingest({
      sessionId,
      message: makeMessage({ role: "user", content: "hammer" }),
    });
    await engine.ingest({
      sessionId,
      message: makeMessage({ role: "assistant", content: "ok" }),
    });
    const conversation = await engine
      .getConversationStore()
      .getConversationBySessionId(sessionId);
    const wikiEngine = new WikiRetrievalEngine({ vaultPath, refreshIntervalMs: 0 });

    const assembler = new ContextAssembler(
      engine.getConversationStore(),
      engine.getSummaryStore(),
      "UTC",
      wikiEngine,
    );
    const result = await assembler.assemble({
      conversationId: conversation!.conversationId,
      tokenBudget: 10_000,
      prompt: "hammer cycle",
      wikiBudget: 4000,
    });
    expect(result.debug?.wikiHitCount).toBe(0);
    expect(result.debug?.wikiTokens).toBe(0);
    const head = getMessageContentAsString(result.messages[0] ?? ({ content: "" } as AgentMessage));
    expect(head).not.toContain("<wiki-canon>");
  });

  it("repeated assemble calls produce identical wiki injection (idempotent)", async () => {
    const { engine, vaultPath } = createEngine();
    writeWikiEntry(
      vaultPath,
      "topic.md",
      { id: "topic.x", title: "Hammer cycle", status: "active" },
      "Body about hammer cycle.",
    );
    const sessionId = randomUUID();
    await engine.ingest({
      sessionId,
      message: makeMessage({ role: "user", content: "hammer cycle" }),
    });
    await engine.ingest({
      sessionId,
      message: makeMessage({ role: "assistant", content: "ok" }),
    });
    const conversation = await engine
      .getConversationStore()
      .getConversationBySessionId(sessionId);
    const wikiEngine = new WikiRetrievalEngine({ vaultPath, refreshIntervalMs: 60_000 });

    const assembler = new ContextAssembler(
      engine.getConversationStore(),
      engine.getSummaryStore(),
      "UTC",
      wikiEngine,
    );
    const a = await assembler.assemble({
      conversationId: conversation!.conversationId,
      tokenBudget: 10_000,
      prompt: "hammer cycle",
      wikiBudget: 4000,
    });
    const b = await assembler.assemble({
      conversationId: conversation!.conversationId,
      tokenBudget: 10_000,
      prompt: "hammer cycle",
      wikiBudget: 4000,
    });
    expect(a.debug?.wikiHitCount).toBe(b.debug?.wikiHitCount);
    expect(a.debug?.wikiTokens).toBe(b.debug?.wikiTokens);
    expect(getMessageContentAsString(a.messages[0])).toBe(getMessageContentAsString(b.messages[0]));
  });
});
