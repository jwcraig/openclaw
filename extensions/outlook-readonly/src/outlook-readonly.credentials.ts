import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

export type MicrosoftStoredOAuth = {
  provider: "microsoft";
  upn: string;
  createdAt: string;
  updatedAt: string;
  accessToken: string;
  refreshToken: string;
  expiresAtMs: number;
  scope: string;
  tokenType: string;
  tenant: string;
};

function safeFileSegment(input: string) {
  const trimmed = input.trim();
  const replaced = trimmed.replaceAll(/[^\w@.+-]/g, "_");
  return replaced || "account";
}

function resolveCredentialsRoot(api: OpenClawPluginApi): string {
  const override = process.env.OPENCLAW_OAUTH_DIR?.trim();
  if (override) {
    return path.resolve(override);
  }
  const stateDir = api.runtime.state.resolveStateDir(process.env, os.homedir);
  return path.join(stateDir, "credentials");
}

export function resolveOutlookReadonlyAuthDir(api: OpenClawPluginApi) {
  return path.join(resolveCredentialsRoot(api), "outlook-readonly");
}

export function resolveOutlookReadonlyTokenPath(api: OpenClawPluginApi, upn: string) {
  return path.join(resolveOutlookReadonlyAuthDir(api), `${safeFileSegment(upn)}.json`);
}

export async function listStoredMicrosoftAccounts(api: OpenClawPluginApi): Promise<string[]> {
  const dir = resolveOutlookReadonlyAuthDir(api);
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".json"))
      .map((e) => e.name.replace(/\.json$/, ""))
      .toSorted((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

export async function readMicrosoftOAuth(api: OpenClawPluginApi, upn: string): Promise<MicrosoftStoredOAuth> {
  const filePath = resolveOutlookReadonlyTokenPath(api, upn);
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as Partial<MicrosoftStoredOAuth>;
  if (parsed.provider !== "microsoft") {
    throw new Error("invalid token file (provider mismatch)");
  }
  if (!parsed.upn || typeof parsed.upn !== "string") {
    throw new Error("invalid token file (missing upn)");
  }
  if (!parsed.refreshToken || typeof parsed.refreshToken !== "string") {
    throw new Error("invalid token file (missing refreshToken)");
  }
  if (!parsed.accessToken || typeof parsed.accessToken !== "string") {
    throw new Error("invalid token file (missing accessToken)");
  }
  if (!parsed.expiresAtMs || typeof parsed.expiresAtMs !== "number") {
    throw new Error("invalid token file (missing expiresAtMs)");
  }
  if (!parsed.tenant || typeof parsed.tenant !== "string") {
    throw new Error("invalid token file (missing tenant)");
  }
  return parsed as MicrosoftStoredOAuth;
}

export async function writeMicrosoftOAuth(api: OpenClawPluginApi, oauth: MicrosoftStoredOAuth) {
  const dir = resolveOutlookReadonlyAuthDir(api);
  await fs.mkdir(dir, { recursive: true });
  const filePath = resolveOutlookReadonlyTokenPath(api, oauth.upn);
  const tmpPath = `${filePath}.tmp`;
  const body = `${JSON.stringify(oauth, null, 2)}\n`;
  await fs.writeFile(tmpPath, body, { encoding: "utf8" });
  try {
    await fs.chmod(tmpPath, 0o600);
  } catch {
    // ignore
  }
  await fs.rename(tmpPath, filePath);
}

