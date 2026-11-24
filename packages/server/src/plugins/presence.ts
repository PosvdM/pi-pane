import { randomUUID } from "node:crypto";
import type {
  PresenceDevice, RequestOrigin, UserPresenceApi, UserPresenceError,
  UserPresenceProof, UserPresenceRequest,
} from "@pi-pane/plugin-api";
import { PaneError } from "../errors.js";

type Connection = {
  id: string;
  credential: string;
  send: (message: unknown) => void;
  device?: PresenceDevice;
};
type Pending = {
  source: string;
  recipients: Set<Connection>;
  dispatching: boolean;
  timer: ReturnType<typeof setTimeout>;
  resolve: (proof: UserPresenceProof) => void;
  reject: (error: UserPresenceError) => void;
};
type Listener = { source: string; callback: () => void };

function failure(code: UserPresenceError["code"]): UserPresenceError {
  const messages = {
    rejected: "用户确认已取消", timeout: "用户确认超时",
    noDevice: "没有可接收确认的在线浏览器", unsupported: "浏览器不支持用户确认",
  };
  return Object.assign(new Error(messages[code]), { code });
}

function validDevice(value: unknown): value is PresenceDevice {
  if (!value || typeof value !== "object") return false;
  const device = value as PresenceDevice;
  return typeof device.deviceId === "string" && device.deviceId.length > 0
    && typeof device.publicKey === "string" && device.publicKey.length > 0
    && device.alg === "ECDSA-P256-SHA256" && typeof device.label === "string"
    && typeof device.connected === "boolean";
}

// 拒绝 JSON 会丢弃或隐式转换的数据，避免确认内容与实际签名内容不一致。
function snapshot(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || value === null || ancestors.has(value)) {
    throw new PaneError("invalidPresencePayload", "确认内容必须是严格的 JSON 值");
  }
  const array = Array.isArray(value);
  if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new PaneError("invalidPresencePayload", "确认内容只能包含普通对象和数组");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors).filter(key => !(array && key === "length"));
  if (keys.some(key => typeof key !== "string" || !descriptors[key].enumerable || !("value" in descriptors[key]))) {
    throw new PaneError("invalidPresencePayload", "确认内容不能包含访问器或隐藏字段");
  }
  if (array && (keys.length !== value.length || keys.some((key, index) => key !== String(index)))) {
    throw new PaneError("invalidPresencePayload", "确认数组不能包含空位或额外字段");
  }
  ancestors.add(value);
  try {
    const entries = keys.map(key => [key, snapshot(descriptors[key as string].value, ancestors)] as const);
    return array ? entries.map(([, item]) => item) : Object.fromEntries(entries);
  } finally {
    ancestors.delete(value);
  }
}

export class PresenceBroker {
  private readonly connections = new Map<string, Connection>();
  private readonly origins = new WeakMap<RequestOrigin, Connection>();
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<Listener>();
  private closed = false;

  connect(connectionId: string, credential: string, send: (message: unknown) => void): void {
    if (this.closed) throw new PaneError("presenceClosed", "用户确认服务已关闭");
    if (!connectionId || !credential || typeof send !== "function") {
      throw new PaneError("invalidPresenceConnection", "浏览器连接信息无效");
    }
    this.disconnect(connectionId);
    this.connections.set(connectionId, { id: connectionId, credential, send });
  }

  device(connectionId: string, device: PresenceDevice): void {
    const connection = this.connections.get(connectionId);
    if (!connection) throw new PaneError("invalidOrigin", "浏览器连接已离线");
    if (!validDevice(device)) throw new PaneError("invalidPresenceDevice", "设备信息无效");
    // 在线状态由连接决定，设备注册只提供显示信息和路由信息。
    connection.device = {
      deviceId: device.deviceId, publicKey: device.publicKey, alg: device.alg,
      label: device.label, connected: true,
    };
    this.devicesChanged();
  }

  disconnect(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    this.connections.delete(connectionId);
    for (const [id, pending] of this.pending) {
      pending.recipients.delete(connection);
      if (!pending.dispatching && !pending.recipients.size) this.finish(id, { error: "noDevice" });
    }
    if (connection.device) this.devicesChanged();
  }

  origin(connectionId: string, credential: string): RequestOrigin {
    const connection = this.connections.get(connectionId);
    if (!connection || connection.credential !== credential) {
      throw new PaneError("invalidOrigin", "请求来源与在线浏览器连接不匹配", 403);
    }
    const origin: RequestOrigin = {
      client: "browser", connectionId, receivedAt: new Date().toISOString(),
      ...(connection.device ? { deviceId: connection.device.deviceId } : {}),
    };
    this.origins.set(origin, connection);
    return origin;
  }

  api(source: string): UserPresenceApi {
    return {
      devices: () => {
        const devices = new Map<string, PresenceDevice>();
        for (const connection of this.connections.values()) {
          if (connection.device) devices.set(connection.device.deviceId, { ...connection.device });
        }
        return [...devices.values()];
      },
      onDevicesChange: callback => {
        const listener = { source, callback };
        if (!this.closed) this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
      },
      confirm: async req => this.confirm(source, req),
    };
  }

  respond(connectionId: string, id: string, response: { proof?: UserPresenceProof; error?: "rejected" | "unsupported" }): void {
    const connection = this.connections.get(connectionId);
    const pending = this.pending.get(id);
    if (!connection || !pending?.recipients.has(connection) || !response || typeof response !== "object") return;
    if (response.error === "rejected" || response.error === "unsupported") {
      if (response.proof === undefined) this.finish(id, { error: response.error }, connection);
      return;
    }
    const proof = response.proof;
    const device = connection.device;
    if (response.error !== undefined || !proof || typeof proof !== "object" || !device
      || typeof proof.deviceId !== "string" || proof.deviceId !== device.deviceId
      || typeof proof.publicKey !== "string" || proof.publicKey !== device.publicKey
      || proof.alg !== "ECDSA-P256-SHA256" || proof.alg !== device.alg
      || typeof proof.signature !== "string" || !proof.signature.length) return;
    // 签名保持不透明，由插件后台核验签名、挑战内容和设备信任关系。
    this.finish(id, { proof: {
      deviceId: proof.deviceId, publicKey: proof.publicKey, alg: proof.alg, signature: proof.signature,
    } }, connection);
  }

  cancelSource(source: string): void {
    for (const listener of this.listeners) {
      if (listener.source === source) this.listeners.delete(listener);
    }
    for (const [id, pending] of this.pending) {
      if (pending.source === source) this.finish(id, { error: "rejected" });
    }
  }

  close(): void {
    this.closed = true;
    this.listeners.clear();
    for (const id of this.pending.keys()) this.finish(id, { error: "rejected" });
    this.connections.clear();
  }

  private confirm(source: string, req: UserPresenceRequest): Promise<UserPresenceProof> {
    if (!req || typeof req.title !== "string" || typeof req.summary !== "string") {
      throw new PaneError("invalidPresenceRequest", "确认标题和说明必须是字符串");
    }
    const payload = snapshot(req.payload);
    const timeoutMs = req.timeoutMs ?? 120_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new PaneError("invalidPresenceRequest", "确认超时必须为正整数毫秒");
    }
    const originConnection = req.origin && this.origins.get(req.origin);
    const preferred = req.origin && req.origin.client === "browser"
      && this.connections.get(req.origin.connectionId) === originConnection ? originConnection : undefined;
    const targets = preferred ? [preferred] : [...this.connections.values()];
    if (this.closed || !targets.length) return Promise.reject(failure("noDevice"));
    const { title, summary } = req;
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.finish(id, { error: "timeout" }), Math.min(timeoutMs, 600_000));
      timer.unref();
      const recipients = new Set<Connection>();
      const pending: Pending = { source, recipients, dispatching: true, timer, resolve, reject };
      this.pending.set(id, pending);
      // 各连接使用独立快照，发送回调不能改动其他浏览器收到的挑战。
      for (const connection of targets) {
        if (!this.pending.has(id)) break;
        if (this.connections.get(connection.id) !== connection) continue;
        recipients.add(connection);
        try {
          connection.send({ type: "presence", request: {
            id, title, summary, payload: snapshot(payload), source,
          } });
        } catch {
          recipients.delete(connection);
        }
      }
      pending.dispatching = false;
      if (!recipients.size) this.finish(id, { error: "noDevice" });
    });
  }

  private finish(id: string, response: { proof?: UserPresenceProof; error?: UserPresenceError["code"] }, winner?: Connection): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (response.proof) pending.resolve(response.proof);
    else pending.reject(failure(response.error!));
    const reason = response.proof ? "confirmed" : response.error === "timeout" ? "timeout" : "cancelled";
    for (const connection of pending.recipients) {
      if (connection === winner) continue;
      try { connection.send({ type: "presenceClosed", id, reason }); } catch { /* 关闭通知不影响其他连接。 */ }
    }
  }

  private devicesChanged(): void {
    for (const listener of [...this.listeners]) {
      if (!this.listeners.has(listener)) continue;
      try { listener.callback(); } catch { /* 插件监听异常不能中断设备注册。 */ }
    }
  }
}
