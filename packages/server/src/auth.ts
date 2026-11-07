import { randomBytes } from 'node:crypto';

const PAIR_TTL_MS = 10 * 60_000;
const IDLE_MS = 24 * 60 * 60_000;
const TICKET_TTL_MS = 30_000;

function unauthorized(code: string, message: string) {
  return Object.assign(new Error(message), { status: 401, code });
}

const randomToken = (bytes: number) => randomBytes(bytes).toString('base64url');

export class AuthStore {
  readonly instanceId = randomToken(16);
  readonly #now: () => number;
  readonly #codes = new Map<string, { createdAt: number; failures: number }>();
  readonly #credentials = new Map<string, { lastUsed: number }>();
  readonly #tickets = new Map<string, { credential: string; expiresAt: number }>();
  readonly #listeners = new Set<(credential: string) => void>();

  constructor({ now = Date.now }: { now?: () => number } = {}) {
    this.#now = now;
  }

  issuePairCode(): string {
    this.#pruneCodes(this.#now());
    const code = randomBytes(10).toString('hex');
    this.#codes.set(code, { createdAt: this.#now(), failures: 0 });
    return code;
  }

  pair(code: string): { credential: string; instanceId: string } {
    const now = this.#now();
    this.#pruneCodes(now);
    if (!this.#codes.delete(code)) {
      // 无法判断请求在猜哪个码，因此错误计入每个仍有效的配对码。
      for (const [value, entry] of this.#codes) {
        if (++entry.failures >= 5) this.#codes.delete(value);
      }
      throw unauthorized('invalid_code', '配对码无效或已过期，请生成新的配对码。');
    }
    const credential = randomToken(32);
    this.#credentials.set(credential, { lastUsed: now });
    return { credential, instanceId: this.instanceId };
  }

  // HTTP 请求、WebSocket 首帧和业务帧共用此检查，并刷新活动时间。
  useCredential(token: string): boolean {
    const entry = this.#credentials.get(token);
    if (!entry) return false;
    const now = this.#now();
    if (now - entry.lastUsed > IDLE_MS) {
      this.revoke(token);
      return false;
    }
    entry.lastUsed = now;
    return true;
  }

  revoke(token: string): void {
    if (!this.#credentials.delete(token)) return;
    for (const [ticket, entry] of this.#tickets) {
      if (entry.credential === token) this.#tickets.delete(ticket);
    }
    for (const listener of [...this.#listeners]) {
      // 一个订阅者失败不能阻止其他连接收到吊销通知。
      try { listener(token); } catch { /* 凭证和 ticket 已作废。 */ }
    }
  }

  issueTicket(token: string): string {
    if (!this.useCredential(token)) {
      throw unauthorized('unauthorized', '凭证无效或已过期，请重新配对。');
    }
    const ticket = randomToken(24);
    this.#tickets.set(ticket, { credential: token, expiresAt: this.#now() + TICKET_TTL_MS });
    return ticket;
  }

  redeemTicket(ticket: string): string {
    const entry = this.#tickets.get(ticket);
    // 查到即消费，即使过期或绑定的凭证无效，也不能再次兑换。
    this.#tickets.delete(ticket);
    if (!entry || this.#now() > entry.expiresAt) {
      throw unauthorized('invalid_ticket', '连接票据无效或已过期，请重新获取。');
    }
    if (!this.useCredential(entry.credential)) {
      throw unauthorized('unauthorized', '凭证无效或已过期，请重新配对。');
    }
    return entry.credential;
  }

  sweep(): void {
    const now = this.#now();
    this.#pruneCodes(now);
    for (const [ticket, entry] of this.#tickets) {
      if (now > entry.expiresAt) this.#tickets.delete(ticket);
    }
    // 清理只检查空闲时间，不能被当作凭证活动。
    for (const [token, entry] of this.#credentials) {
      if (now - entry.lastUsed > IDLE_MS) this.revoke(token);
    }
  }

  onRevoke(listener: (credential: string) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  #pruneCodes(now: number): void {
    for (const [code, entry] of this.#codes) {
      if (now - entry.createdAt > PAIR_TTL_MS) this.#codes.delete(code);
    }
  }
}

export function checkOrigin(
  headers: { host?: string; origin?: string },
  port: number,
): boolean {
  const host = `127.0.0.1:${port}`;
  return headers.host === host
    && (headers.origin === undefined || headers.origin === `http://${host}`);
}
