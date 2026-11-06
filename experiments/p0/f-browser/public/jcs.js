// RFC 8785（JCS）规范 JSON。浏览器和 Node.js 共用同一份代码。
// 数字按 ECMAScript Number.prototype.toString 输出（RFC 8785 第 3.2.2.3 节），
// 字符串按 JSON.stringify 转义（第 3.2.2.2 节），对象键按 UTF-16 码元排序（第 3.2.3 节）。

export class JcsError extends TypeError {}

function isWellFormed(s) {
  if (typeof s.isWellFormed === 'function') return s.isWellFormed();
  return !/(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF]))|(?:(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF])/.test(s);
}

function str(s) {
  if (!isWellFormed(s)) throw new JcsError('JCS: string contains lone surrogate');
  return JSON.stringify(s);
}

export function canonicalize(value) {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new JcsError(`JCS: number not allowed: ${value}`);
      // -0 输出为 "0"；其余与 String(value) 相同。
      return Object.is(value, -0) ? '0' : String(value);
    case 'string':
      return str(value);
    case 'object': {
      if (Array.isArray(value)) {
        return '[' + value.map((v) => canonicalize(v)).join(',') + ']';
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new JcsError('JCS: only plain objects are allowed');
      }
      // Array.prototype.sort 的默认比较按 UTF-16 码元比较字符串。
      const keys = Object.keys(value).sort();
      const parts = [];
      for (const k of keys) {
        const v = value[k];
        if (v === undefined) throw new JcsError(`JCS: undefined value at key ${k}`);
        parts.push(str(k) + ':' + canonicalize(v));
      }
      return '{' + parts.join(',') + '}';
    }
    default:
      throw new JcsError(`JCS: unsupported type ${typeof value}`);
  }
}

export function canonicalBytes(value) {
  return new TextEncoder().encode(canonicalize(value));
}

export const PRESENCE_DOMAIN = 'pi-pane/user-presence/v1';

/** userPresence 的签名对象（plugin-api.md“签名格式”）。 */
export function presenceSigningBytes(payload, domain = PRESENCE_DOMAIN) {
  return canonicalBytes({ domain, payload });
}

export function b64url(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(s) {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  const u8 = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) u8[i] = b.charCodeAt(i);
  return u8;
}
