import { randomUUID } from "node:crypto";
import { readFile, copyFile, mkdtemp, rm, writeFile, mkdir, readdir } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { comparisonKey, realPathOrPending, type PiInstall } from "pi-hostkit";
import { assert } from "./errors.js";
import { firstUserText } from "./session-title.js";

export interface Entry { type: string; id: string; parentId: string | null; [key: string]: any }
export interface SessionFile { header?: Record<string, any>; entries: Entry[]; leafId: string | null; diagnostics: string[] }
export function parseSession(text: string): SessionFile {
  const records: any[] = []; const diagnostics: string[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line);
      if (item && typeof item === "object" && typeof item.type === "string") records.push(item);
      else diagnostics.push(`第 ${index + 1} 行不是会话条目`);
    } catch { diagnostics.push(`第 ${index + 1} 行不完整或不是 JSON，已跳过`); }
  }
  const header = records.find((r) => r.type === "session");
  const version = header?.version ?? 1;
  assert(version >= 1 && version <= 3, "sessionVersion", "不支持此会话文件版本");
  if (version < 2) {
    let previous: string | null = null;
    for (const entry of records) {
      if (entry.type === "session") continue;
      entry.id = randomUUID().slice(0, 8); entry.parentId = previous; previous = entry.id;
      if (entry.type === "compaction" && typeof entry.firstKeptEntryIndex === "number") {
        entry.firstKeptEntryId = records[entry.firstKeptEntryIndex]?.id; delete entry.firstKeptEntryIndex;
      }
    }
  }
  if (version < 3) for (const entry of records) if (entry.type === "message" && entry.message?.role === "hookMessage") entry.message.role = "custom";
  const entries = records.filter((r) => r.type !== "session" && typeof r.id === "string") as Entry[];
  return { header: header && { ...header, version: 3 }, entries, leafId: entries.at(-1)?.id ?? null, diagnostics };
}
export async function readSession(file: string): Promise<SessionFile> {
  try { return parseSession(await readFile(file, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries: [], leafId: null, diagnostics: [] }; throw error; }
}
export function branch(entries: readonly Entry[], leafId: string | null): Entry[] {
  const index = new Map(entries.map((e) => [e.id, e])); const result: Entry[] = []; const seen = new Set<string>();
  for (let id = leafId; id;) {
    assert(!seen.has(id), "sessionCycle", "会话条目存在循环引用"); seen.add(id);
    const entry = index.get(id); if (!entry) break;
    result.push(entry); id = entry.parentId;
  }
  return result.reverse();
}
export function fileKey(file: string): string {
  return comparisonKey(realPathOrPending(file));
}
/** 目录占位有歧义时，只读到首条文本即关闭文件，不再读余下存档。 */
async function readFirstUserText(file: string): Promise<string> {
  const input = createReadStream(file, { encoding: "utf8" }); const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let entry: Entry; try { entry = JSON.parse(line); } catch { continue; }
      if (!entry || typeof entry !== "object") continue;
      const text = firstUserText([entry]); if (text) return text;
    }
    return "";
  } finally { lines.close(); input.destroy(); }
}
export class PiStore {
  private modules?: Promise<any>;
  constructor(readonly install: PiInstall, readonly agentDir: string, readonly tmpDir: string, private readonly env: NodeJS.ProcessEnv = process.env) {}
  private api(): Promise<any> { return this.modules ??= import(pathToFileURL(path.join(this.install.packageDir, "dist/index.js")).href); }
  async trust(cwd: string): Promise<{ resources: boolean; saved?: boolean }> {
    const pi = await this.api();
    return { resources: pi.hasTrustRequiringProjectResources(cwd), saved: new pi.ProjectTrustStore(this.agentDir).get(cwd) };
  }
  async sessionDir(cwd?: string): Promise<string> {
    if (this.env.PI_CODING_AGENT_SESSION_DIR) return path.resolve(cwd ?? process.cwd(), this.env.PI_CODING_AGENT_SESSION_DIR.replace(/^~(?=[/\\\\])/, this.env.HOME ?? ""));
    let setting: string | undefined;
    for (const file of [path.join(this.agentDir, "settings.json"), ...(cwd ? [path.join(cwd, ".pi/settings.json")] : [])]) {
      try { const value = JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, "")); if (typeof value.sessionDir === "string") setting = value.sessionDir; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    return setting ? path.resolve(cwd ?? this.agentDir, setting.replace(/^~(?=[/\\])/, this.env.HOME ?? "")) : path.join(this.agentDir, "sessions");
  }
  async list(cwds: string[] = []): Promise<any[]> {
    const pi = await this.api(); const unique = new Map<string, any>();
    const add = (rows: any[]) => { for (const row of rows) unique.set(fileKey(row.path), row); };
    const root = await this.sessionDir();
    add(await pi.SessionManager.listAll(root));
    // pi 默认存储按编码后的 cwd 分目录；显式传入根目录的 listAll 只读取该目录本身。
    if (fileKey(root) === fileKey(path.join(this.agentDir, "sessions")) && !this.env.PI_CODING_AGENT_SESSION_DIR) {
      try { for (const entry of await readdir(root, { withFileTypes: true })) if (entry.isDirectory()) add(await pi.SessionManager.listAll(path.join(root, entry.name))); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    for (const cwd of cwds) add(await pi.SessionManager.list(cwd, await this.sessionDir(cwd)));
    const rows: any[] = [];
    for (const row of unique.values()) {
      let text = typeof row.firstMessage === "string" ? row.firstMessage : "";
      if (text === "(no messages)") {
        if (row.messageCount === 0 || typeof row.allMessagesText === "string" && !row.allMessagesText.includes(text)) text = "";
        else {
          // 占位值也可能是用户真的输入的文本；仅此歧义需要只读复核。
          try { text = await readFirstUserText(row.path); }
          catch (error) { console.warn(`无法读取会话标题：${row.path}`, error); continue; }
        }
      }
      rows.push({ ...row, firstUserText: text });
    }
    return rows;
  }
  async fork(source: string, cwd: string, sessionDir: string): Promise<string> {
    await mkdir(this.tmpDir, { recursive: true }); await mkdir(sessionDir, { recursive: true });
    const temp = await mkdtemp(path.join(this.tmpDir, "fork-"));
    try {
      const copy = path.join(temp, "source.jsonl"); await copyFile(source, copy);
      const pi = await this.api(); const manager = pi.SessionManager.forkFrom(copy, cwd, sessionDir);
      const target: string = manager.getSessionFile();
      const text = await readFile(target, "utf8"); const end = text.indexOf("\n");
      const header = JSON.parse(end < 0 ? text : text.slice(0, end)); header.parentSession = realPathOrPending(source);
      await writeFile(target, JSON.stringify(header) + (end < 0 ? "\n" : text.slice(end)), { mode: 0o600 });
      return target;
    } finally { await rm(temp, { recursive: true, force: true }); }
  }
}
