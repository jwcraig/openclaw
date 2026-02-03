import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { stringEnum } from "openclaw/plugin-sdk";

export type ObsidianVaultPluginConfig = {
  vaultRoot: string;
  allowWrite: boolean;
  denyDotObsidian: boolean;
  maxReadBytes: number;
  maxWriteBytes: number;
  maxSearchBytesPerFile: number;
};

type ToolAction =
  | {
      action: "read_note";
      path: string;
    }
  | {
      action: "write_note";
      path: string;
      content: string;
      mode?: "overwrite" | "append";
    }
  | {
      action: "upsert_section";
      path: string;
      heading: string;
      content: string;
      level?: number;
    }
  | {
      action: "search";
      query: string;
      maxResults?: number;
      caseSensitive?: boolean;
    };

export const ObsidianVaultToolSchema = Type.Object(
  {
    action: stringEnum(["read_note", "write_note", "upsert_section", "search"]),
    path: Type.Optional(
      Type.String({ description: 'Relative path to a note (e.g. "Projects/Foo.md")' }),
    ),
    content: Type.Optional(Type.String({ description: "Markdown content" })),
    mode: Type.Optional(
      stringEnum(["overwrite", "append"], { description: "Write mode (default: overwrite)" }),
    ),
    heading: Type.Optional(
      Type.String({
        description:
          "Heading text (without leading #). If missing, the tool throws for upsert_section.",
      }),
    ),
    level: Type.Optional(
      Type.Number({
        description:
          "Heading level to use when creating a new section (1-6). If omitted, defaults to 2.",
      }),
    ),
    query: Type.Optional(Type.String({ description: "Plain substring query (not regex)" })),
    maxResults: Type.Optional(Type.Number({ description: "Max matches to return (default 20)" })),
    caseSensitive: Type.Optional(
      Type.Boolean({ description: "Case sensitive match (default false)" }),
    ),
  },
  { additionalProperties: false },
);

function normalizeRelativeVaultPath(input: string) {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("path is required");
  }
  const normalized = trimmed.replaceAll("\\", "/");
  if (normalized.includes("\0")) {
    throw new Error("path contains invalid characters");
  }
  if (normalized.startsWith("/")) {
    throw new Error("path must be relative (no leading /)");
  }
  if (/^[a-zA-Z]:[\\/]/.test(trimmed)) {
    throw new Error("path must be relative (no drive letter)");
  }
  if (normalized.startsWith("../") || normalized === ".." || normalized.includes("/../")) {
    throw new Error("path must stay within the vault root");
  }
  if (normalized.startsWith("./")) {
    return normalized.slice(2);
  }
  return normalized;
}

function resolveVaultPath(cfg: ObsidianVaultPluginConfig, relativePath: string) {
  const rel = normalizeRelativeVaultPath(relativePath);
  if (cfg.denyDotObsidian) {
    const firstSegment = rel.split("/")[0];
    if (firstSegment === ".obsidian") {
      throw new Error('paths under ".obsidian/" are not allowed');
    }
  }
  if (path.extname(rel).toLowerCase() !== ".md") {
    throw new Error('only ".md" notes are allowed');
  }
  const root = path.resolve(cfg.vaultRoot);
  const abs = path.resolve(root, rel);
  const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (abs !== root && !abs.startsWith(rootWithSep)) {
    throw new Error("resolved path escapes vault root");
  }
  return { abs, rel, root };
}

async function readNote(cfg: ObsidianVaultPluginConfig, relativePath: string) {
  const { abs } = resolveVaultPath(cfg, relativePath);
  const stat = await fs.stat(abs);
  if (!stat.isFile()) {
    throw new Error("path is not a file");
  }
  if (stat.size > cfg.maxReadBytes) {
    throw new Error(`note is too large to read (${stat.size} bytes > ${cfg.maxReadBytes})`);
  }
  return await fs.readFile(abs, { encoding: "utf8" });
}

async function writeNote(
  cfg: ObsidianVaultPluginConfig,
  relativePath: string,
  content: string,
  mode: "overwrite" | "append",
) {
  if (!cfg.allowWrite) {
    throw new Error("writes are disabled by config (allowWrite=false)");
  }

  const { abs } = resolveVaultPath(cfg, relativePath);
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > cfg.maxWriteBytes) {
    throw new Error(`content is too large to write (${bytes} bytes > ${cfg.maxWriteBytes})`);
  }

  await fs.mkdir(path.dirname(abs), { recursive: true });

  if (mode === "append") {
    await fs.appendFile(abs, content, { encoding: "utf8" });
    return;
  }

  await fs.writeFile(abs, content, { encoding: "utf8" });
}

function normalizeUpsertHeadingText(input: string) {
  const raw = input.trim();
  if (!raw) {
    throw new Error("heading is required");
  }
  // Be tolerant if the caller includes leading hashes.
  const withoutHashes = raw.replace(/^#{1,6}\s+/, "").trim();
  if (!withoutHashes) {
    throw new Error("heading is required");
  }
  if (withoutHashes.includes("\0")) {
    throw new Error("heading contains invalid characters");
  }
  return withoutHashes;
}

function clampHeadingLevel(level: number | undefined) {
  if (typeof level !== "number" || !Number.isFinite(level)) {
    return 2;
  }
  const n = Math.floor(level);
  if (n < 1) return 1;
  if (n > 6) return 6;
  return n;
}

function isMarkdownHeadingLine(line: string) {
  return /^#{1,6}\s+\S/.test(line.trimEnd());
}

function parseMarkdownHeading(line: string) {
  const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
  if (!m) return null;
  return { level: m[1]?.length ?? 0, text: m[2] ?? "" };
}

function ensureTrailingNewline(text: string) {
  return text.endsWith("\n") ? text : `${text}\n`;
}

async function upsertSection(
  cfg: ObsidianVaultPluginConfig,
  relativePath: string,
  headingText: string,
  content: string,
  level?: number,
) {
  const { abs } = resolveVaultPath(cfg, relativePath);
  const desiredHeading = normalizeUpsertHeadingText(headingText);
  const createLevel = clampHeadingLevel(level);

  if (!cfg.allowWrite) {
    throw new Error("writes are disabled by config (allowWrite=false)");
  }

  const newSectionLines: string[] = [];
  newSectionLines.push(`${"#".repeat(createLevel)} ${desiredHeading}`);
  newSectionLines.push("");
  newSectionLines.push(...ensureTrailingNewline(content).split(/\r?\n/).slice(0, -1));
  newSectionLines.push("");

  let existing = "";
  try {
    const stat = await fs.stat(abs);
    if (!stat.isFile()) {
      throw new Error("path is not a file");
    }
    if (stat.size > cfg.maxReadBytes) {
      throw new Error(`note is too large to edit (${stat.size} bytes > ${cfg.maxReadBytes})`);
    }
    existing = await fs.readFile(abs, { encoding: "utf8" });
  } catch (err) {
    // File doesn't exist yet → treat as empty and create.
    existing = "";
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      // @ts-expect-error node error shape
      (err.code === "ENOENT" || err.code === "ENOTDIR")
    ) {
      // ok
    }
  }

  const originalLines = existing ? existing.split(/\r?\n/) : [];
  const lines: string[] = existing ? [...originalLines] : [];

  let startIndex = -1;
  let foundLevel = createLevel;
  for (let i = 0; i < lines.length; i++) {
    const parsed = parseMarkdownHeading(lines[i] ?? "");
    if (!parsed) continue;
    if (parsed.text.trim() === desiredHeading) {
      startIndex = i;
      foundLevel = parsed.level;
      break;
    }
  }

  let outLines: string[] = [];
  if (startIndex === -1) {
    // Append to end.
    outLines = [...lines];
    while (outLines.length > 0 && outLines[outLines.length - 1] === "") {
      outLines.pop();
    }
    if (outLines.length > 0) {
      outLines.push("");
      outLines.push("");
    }
    outLines.push(...newSectionLines);
  } else {
    // Replace the section content until the next heading of the same or higher level.
    let endIndex = lines.length;
    for (let i = startIndex + 1; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (!isMarkdownHeadingLine(line)) {
        continue;
      }
      const parsed = parseMarkdownHeading(line);
      if (!parsed) continue;
      if (parsed.level <= foundLevel) {
        endIndex = i;
        break;
      }
    }

    const prefix = lines.slice(0, startIndex);
    const suffix = lines.slice(endIndex);

    // Preserve the original heading level if it existed, but keep the requested heading text.
    const headingLine = `${"#".repeat(foundLevel)} ${desiredHeading}`;
    const replacement = [
      headingLine,
      "",
      ...ensureTrailingNewline(content).split(/\r?\n/).slice(0, -1),
      "",
    ];
    outLines = [...prefix, ...replacement, ...suffix];
  }

  // Normalize to end with a trailing newline.
  const out = ensureTrailingNewline(outLines.join("\n"));
  const bytes = Buffer.byteLength(out, "utf8");
  if (bytes > cfg.maxWriteBytes) {
    throw new Error(`resulting note is too large to write (${bytes} bytes > ${cfg.maxWriteBytes})`);
  }

  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, out, { encoding: "utf8" });
}

function shouldSkipSearchDir(name: string) {
  if (!name) return true;
  if (name === ".git") return true;
  if (name === "node_modules") return true;
  if (name === ".trash" || name === "Trash") return true;
  return false;
}

export async function searchVault(cfg: ObsidianVaultPluginConfig, params: {
  query: string;
  maxResults: number;
  caseSensitive: boolean;
}) {
  const query = params.query.trim();
  if (!query) {
    throw new Error("query is required");
  }

  const root = path.resolve(cfg.vaultRoot);
  const maxResults = Math.max(1, Math.min(200, params.maxResults));
  const caseSensitive = params.caseSensitive;
  const needle = caseSensitive ? query : query.toLowerCase();

  const results: Array<{ path: string; line: number; preview: string }> = [];
  const dirs: string[] = [root];

  while (dirs.length > 0 && results.length < maxResults) {
    const dir = dirs.pop();
    if (!dir) break;

    let entries: Array<import("node:fs").Dirent>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (results.length >= maxResults) break;
      const abs = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (cfg.denyDotObsidian && entry.name === ".obsidian") {
          continue;
        }
        if (shouldSkipSearchDir(entry.name)) {
          continue;
        }
        dirs.push(abs);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }
      if (path.extname(entry.name).toLowerCase() !== ".md") {
        continue;
      }

      let buf: string;
      try {
        const stat = await fs.stat(abs);
        if (!stat.isFile()) continue;
        if (stat.size > cfg.maxSearchBytesPerFile) {
          continue;
        }
        buf = await fs.readFile(abs, { encoding: "utf8" });
      } catch {
        continue;
      }

      const haystack = caseSensitive ? buf : buf.toLowerCase();
      if (!haystack.includes(needle)) {
        continue;
      }

      const rel = path.relative(root, abs).replaceAll(path.sep, "/");
      const lines = buf.split(/\r?\n/);
      for (let i = 0; i < lines.length && results.length < maxResults; i++) {
        const lineText = lines[i] ?? "";
        const lineHay = caseSensitive ? lineText : lineText.toLowerCase();
        if (!lineHay.includes(needle)) continue;
        results.push({
          path: rel,
          line: i + 1,
          preview: lineText.slice(0, 300),
        });
      }
    }
  }

  return results;
}

export function createObsidianVaultTool(api: OpenClawPluginApi, cfg: ObsidianVaultPluginConfig) {
  return {
    name: "obsidian_vault",
    label: "Obsidian Vault",
    description:
      "Read/write/search Obsidian notes within a configured vault directory. " +
      'Actions: read_note, write_note, upsert_section, search. Notes must be ".md" and paths must be relative.',
    parameters: ObsidianVaultToolSchema,
    async execute(_id: string, params: ToolAction) {
      const action = params.action;
      if (action === "read_note") {
        if (!("path" in params) || typeof params.path !== "string") {
          throw new Error("path is required");
        }
        const text = await readNote(cfg, params.path);
        return {
          content: [{ type: "text", text }],
          details: { ok: true, action, path: params.path },
        };
      }

      if (action === "write_note") {
        if (!("path" in params) || typeof params.path !== "string") {
          throw new Error("path is required");
        }
        if (!("content" in params) || typeof params.content !== "string") {
          throw new Error("content is required");
        }
        const mode = params.mode === "append" ? "append" : "overwrite";
        await writeNote(cfg, params.path, params.content, mode);
        return {
          content: [{ type: "text", text: `Wrote ${params.path} (${mode}).` }],
          details: { ok: true, action, path: params.path, mode },
        };
      }

      if (action === "upsert_section") {
        if (!("path" in params) || typeof params.path !== "string") {
          throw new Error("path is required");
        }
        if (!("heading" in params) || typeof params.heading !== "string") {
          throw new Error("heading is required");
        }
        if (!("content" in params) || typeof params.content !== "string") {
          throw new Error("content is required");
        }
        await upsertSection(cfg, params.path, params.heading, params.content, params.level);
        return {
          content: [{ type: "text", text: `Upserted section "${params.heading}" in ${params.path}.` }],
          details: { ok: true, action, path: params.path, heading: params.heading },
        };
      }

      if (action === "search") {
        if (!("query" in params) || typeof params.query !== "string") {
          throw new Error("query is required");
        }
        const maxResults =
          typeof params.maxResults === "number" && Number.isFinite(params.maxResults)
            ? params.maxResults
            : 20;
        const caseSensitive = params.caseSensitive === true;
        const results = await searchVault(cfg, { query: params.query, maxResults, caseSensitive });
        const body =
          results.length === 0
            ? "No matches."
            : results
                .map((m) => `${m.path}:${m.line} ${m.preview}`)
                .join("\n");
        return {
          content: [{ type: "text", text: body }],
          details: { ok: true, action, query: params.query, count: results.length, results },
        };
      }

      api.logger.warn(`[obsidian-vault] unknown action: ${(params as any).action}`);
      throw new Error("unknown action");
    },
  };
}
