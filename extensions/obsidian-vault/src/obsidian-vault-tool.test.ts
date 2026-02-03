import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawPluginApi } from "../../../src/plugins/types.js";
import { createObsidianVaultTool, type ObsidianVaultPluginConfig } from "./obsidian-vault-tool.js";

function fakeApi(overrides: Partial<OpenClawPluginApi> = {}): OpenClawPluginApi {
  return {
    id: "obsidian-vault",
    name: "obsidian-vault",
    source: "test",
    config: {},
    pluginConfig: {},
    // oxlint-disable-next-line typescript/no-explicit-any
    runtime: { version: "test" } as any,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    registerTool() {},
    registerHttpHandler() {},
    registerChannel() {},
    registerGatewayMethod() {},
    registerCli() {},
    registerService() {},
    registerProvider() {},
    registerHook() {},
    registerHttpRoute() {},
    registerCommand() {},
    on() {},
    resolvePath: (p) => p,
    ...overrides,
  };
}

async function makeTmpVault(prefix = "openclaw-obsidian-vault-") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.mkdir(path.join(dir, "Projects"), { recursive: true });
  await fs.mkdir(path.join(dir, ".obsidian"), { recursive: true });
  await fs.writeFile(path.join(dir, "Projects", "Alpha.md"), "hello world\nsecond line\n", "utf8");
  await fs.writeFile(path.join(dir, ".obsidian", "app.json"), "{}", "utf8");
  return dir;
}

function baseCfg(vaultRoot: string): ObsidianVaultPluginConfig {
  return {
    vaultRoot,
    allowWrite: true,
    denyDotObsidian: true,
    maxReadBytes: 1_000_000,
    maxWriteBytes: 2_000_000,
    maxSearchBytesPerFile: 250_000,
  };
}

describe("obsidian-vault tool", () => {
  it("reads a note within the vault", async () => {
    const vault = await makeTmpVault();
    const tool = createObsidianVaultTool(fakeApi(), baseCfg(vault));
    const res = await tool.execute("call1", { action: "read_note", path: "Projects/Alpha.md" });
    expect(res.content?.[0]).toMatchObject({ type: "text" });
    expect((res.content?.[0] as any).text).toContain("hello world");
  });

  it("rejects paths that escape the vault", async () => {
    const vault = await makeTmpVault();
    const tool = createObsidianVaultTool(fakeApi(), baseCfg(vault));
    await expect(
      tool.execute("call2", { action: "read_note", path: "../Secrets.md" }),
    ).rejects.toThrow(/stay within/i);
  });

  it('rejects ".obsidian/" by default', async () => {
    const vault = await makeTmpVault();
    const tool = createObsidianVaultTool(fakeApi(), baseCfg(vault));
    await expect(
      tool.execute("call3", { action: "read_note", path: ".obsidian/app.json" }),
    ).rejects.toThrow(/\.obsidian/i);
  });

  it("writes a note (overwrite)", async () => {
    const vault = await makeTmpVault();
    const tool = createObsidianVaultTool(fakeApi(), baseCfg(vault));
    await tool.execute("call4", {
      action: "write_note",
      path: "Projects/Beta.md",
      content: "# Beta\n\nhi\n",
      mode: "overwrite",
    });
    const out = await fs.readFile(path.join(vault, "Projects", "Beta.md"), "utf8");
    expect(out).toContain("# Beta");
  });

  it("upserts a section (create then replace)", async () => {
    const vault = await makeTmpVault();
    const tool = createObsidianVaultTool(fakeApi(), baseCfg(vault));

    await tool.execute("call-upsert-1", {
      action: "upsert_section",
      path: "Projects/Alpha.md",
      heading: "Status",
      content: "First version",
      level: 2,
    });

    const first = await fs.readFile(path.join(vault, "Projects", "Alpha.md"), "utf8");
    expect(first).toContain("## Status");
    expect(first).toContain("First version");

    await tool.execute("call-upsert-2", {
      action: "upsert_section",
      path: "Projects/Alpha.md",
      heading: "Status",
      content: "Second version",
    });

    const second = await fs.readFile(path.join(vault, "Projects", "Alpha.md"), "utf8");
    expect(second).toContain("## Status");
    expect(second).toContain("Second version");
    expect(second).not.toContain("First version");
  });

  it("searches notes", async () => {
    const vault = await makeTmpVault();
    const tool = createObsidianVaultTool(fakeApi(), baseCfg(vault));
    const res = await tool.execute("call5", { action: "search", query: "hello", maxResults: 5 });
    const details = (res as any).details;
    expect(details.count).toBeGreaterThan(0);
    expect(details.results[0].path).toBe("Projects/Alpha.md");
  });
});
