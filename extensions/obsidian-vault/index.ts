import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createObsidianVaultTool } from "./src/obsidian-vault-tool.js";

type ObsidianVaultPluginConfig = {
  enabled: boolean;
  vaultRoot: string;
  allowWrite: boolean;
  denyDotObsidian: boolean;
  maxReadBytes: number;
  maxWriteBytes: number;
  maxSearchBytesPerFile: number;
};

function parseBoolean(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function parseNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function parseString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function parseConfig(value: unknown): ObsidianVaultPluginConfig {
  const raw =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};

  const enabled = parseBoolean(raw.enabled, true);
  const vaultRoot =
    parseString(raw.vaultRoot) || parseString(process.env.OBSIDIAN_VAULT_ROOT) || "";

  if (!vaultRoot) {
    throw new Error(
      '[obsidian-vault] Missing vaultRoot. Set plugins.entries["obsidian-vault"].config.vaultRoot (or OBSIDIAN_VAULT_ROOT).',
    );
  }

  return {
    enabled,
    vaultRoot,
    allowWrite: parseBoolean(raw.allowWrite, true),
    denyDotObsidian: parseBoolean(raw.denyDotObsidian, true),
    maxReadBytes: parseNumber(raw.maxReadBytes, 1_000_000),
    maxWriteBytes: parseNumber(raw.maxWriteBytes, 2_000_000),
    maxSearchBytesPerFile: parseNumber(raw.maxSearchBytesPerFile, 250_000),
  };
}

const obsidianVaultConfigSchema = {
  parse(value: unknown): ObsidianVaultPluginConfig {
    return parseConfig(value);
  },
  uiHints: {
    enabled: { label: "Enabled" },
    vaultRoot: {
      label: "Vault Root",
      help: "Absolute path to your Obsidian vault root folder on the gateway host.",
      placeholder: "/Users/you/Obsidian/MyVault",
    },
    allowWrite: {
      label: "Allow Writes",
      help: "When disabled, obsidian_write_note returns an error instead of writing.",
    },
    denyDotObsidian: {
      label: "Block .obsidian/",
      help: "Disallow reading/writing/searching inside the .obsidian settings directory.",
      advanced: true,
    },
    maxReadBytes: { label: "Max Read Bytes", advanced: true },
    maxWriteBytes: { label: "Max Write Bytes", advanced: true },
    maxSearchBytesPerFile: { label: "Max Search Bytes/File", advanced: true },
  },
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      enabled: { type: "boolean", default: true },
      vaultRoot: { type: "string" },
      allowWrite: { type: "boolean", default: true },
      denyDotObsidian: { type: "boolean", default: true },
      maxReadBytes: { type: "number", default: 1_000_000 },
      maxWriteBytes: { type: "number", default: 2_000_000 },
      maxSearchBytesPerFile: { type: "number", default: 250_000 },
    },
    required: ["vaultRoot"],
  },
};

const plugin = {
  id: "obsidian-vault",
  name: "Obsidian Vault",
  description: "Read/write/search notes within a configured Obsidian vault directory.",
  configSchema: obsidianVaultConfigSchema,
  register(api: OpenClawPluginApi) {
    const config = obsidianVaultConfigSchema.parse(api.pluginConfig);
    if (!config.enabled) {
      api.logger.info("[obsidian-vault] disabled");
      return;
    }
    api.registerTool(createObsidianVaultTool(api, config), { optional: true });
  },
};

export default plugin;

