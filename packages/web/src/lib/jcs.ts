// RFC 8785（JCS）规范 JSON：数字按 ECMAScript Number.prototype.toString 输出，
// 字符串按 JSON.stringify 转义，对象键按 UTF-16 码元排序。浏览器和 Node.js 测试共用。

export class JcsError extends TypeError {}

function str(s: string): string {
  if (!(s as any).isWellFormed()) throw new JcsError("JCS：字符串含有孤立代理项");
  return JSON.stringify(s);
}

export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean": return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new JcsError(`JCS：不允许的数字 ${value}`);
      return Object.is(value, -0) ? "0" : String(value);
    case "string": return str(value);
    case "object": {
      if (Array.isArray(value)) return "[" + value.map((v) => canonicalize(v)).join(",") + "]";
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw new JcsError("JCS：只接受普通对象");
      const record = value as Record<string, unknown>;
      // Array.prototype.sort 的默认比较按 UTF-16 码元比较字符串。
      return "{" + Object.keys(record).sort().map((k) => {
        if (record[k] === undefined) throw new JcsError(`JCS：键 ${k} 的值为 undefined`);
        return str(k) + ":" + canonicalize(record[k]);
      }).join(",") + "}";
    }
    default: throw new JcsError(`JCS：不支持的类型 ${typeof value}`);
  }
}

export const PRESENCE_DOMAIN = "pi-pane/user-presence/v1";

/** userPresence 的签名对象（plugin-api.md“签名格式”）。 */
export function presenceSigningBytes(payload: unknown, domain = PRESENCE_DOMAIN): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(canonicalize({ domain, payload }));
}

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  const u8 = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) u8[i] = b.charCodeAt(i);
  return u8;
}
