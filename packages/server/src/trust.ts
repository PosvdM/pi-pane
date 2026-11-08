import { randomUUID } from "node:crypto";
import type { TrustChoice } from "./bridge.js";
import { fileKey, type PiStore } from "./store.js";
import { assert } from "./errors.js";
export interface TrustRequest { id: string; cwd: string; expiresAt: string }
export class TrustDecisions {
  private choices: Record<string, TrustChoice> = {};
  private pending = new Map<string, { request: TrustRequest; resolve: (choice?: TrustChoice) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(private readonly store: PiStore, private readonly connected: () => boolean,
    private readonly emit: (request: TrustRequest) => void, private readonly timeoutMs = 55000,
    private readonly emitResolved: (id: string) => void = () => {}) {}
  config(): Record<string, TrustChoice> { return { ...this.choices }; }
  async request(cwd: string): Promise<TrustChoice | undefined> {
    const key = fileKey(cwd); if (this.choices[key]) return this.choices[key];
    const prediction = await this.store.trust(cwd);
    if (prediction.saved !== undefined && prediction.saved !== null) return undefined;
    if (!prediction.resources || !this.connected()) return undefined;
    const existing = [...this.pending.values()].find((p) => fileKey(p.request.cwd) === key);
    if (existing) {
      return new Promise((resolve) => { const previous = existing.resolve; existing.resolve = (choice) => { previous(choice); resolve(choice); }; });
    }
    return new Promise((resolve) => {
      const request = { id: randomUUID(), cwd, expiresAt: new Date(Date.now() + this.timeoutMs).toISOString() };
      const timer = setTimeout(() => this.answer(request.id), this.timeoutMs); timer.unref();
      this.pending.set(request.id, { request, resolve, timer }); this.emit(request);
    });
  }
  list(): TrustRequest[] { return [...this.pending.values()].map((p) => p.request); }
  answer(id: string, choice?: TrustChoice): void {
    const pending = this.pending.get(id); assert(pending, "trustExpired", "项目信任询问已处理或过期", 409);
    if (choice) {
      assert(typeof choice.trusted === "boolean" && typeof choice.remember === "boolean", "invalidTrust", "信任决定格式无效");
      this.choices[fileKey(pending.request.cwd)] = choice;
    }
    clearTimeout(pending.timer); this.pending.delete(id); pending.resolve(choice); this.emitResolved(id);
  }
  close(): void { for (const id of this.pending.keys()) this.answer(id); }
}
