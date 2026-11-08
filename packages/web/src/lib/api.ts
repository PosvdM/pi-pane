// HTTP 接口调用：所有请求带 Authorization 头；401 交给鉴权模块处理。
import type { PaneErrorBody } from "./types.ts";

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly body?: PaneErrorBody) { super(message); }
}

let credential: string | null = null;
let onUnauthorized: (body?: PaneErrorBody) => void = () => {};

export function setCredential(value: string | null): void { credential = value; }
export function getCredential(): string | null { return credential; }
export function setUnauthorizedHandler(handler: (body?: PaneErrorBody) => void): void { onUnauthorized = handler; }

async function failure(response: Response): Promise<ApiError> {
  let body: PaneErrorBody | undefined;
  try { body = await response.json(); } catch { /* 非 JSON 错误体按状态码处理。 */ }
  if (response.status === 401) onUnauthorized(body);
  return new ApiError(response.status, body?.error ?? "httpError", body?.message ?? `请求失败（HTTP ${response.status}）`, body);
}

export async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (credential) headers.set("Authorization", "Bearer " + credential);
  let response: Response;
  try { response = await fetch(path, { ...init, headers, cache: "no-store" }); }
  catch { throw new ApiError(0, "network", "无法连接 pi-pane 服务端"); }
  if (!response.ok) throw await failure(response);
  return response;
}

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await request(path, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return response.json() as Promise<T>;
}

export function newId(): string { return crypto.randomUUID(); }
