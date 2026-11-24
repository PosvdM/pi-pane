import type { Server } from "node:http";
import { PaneError } from "./errors.js";

// 来源：https://fetch.spec.whatwg.org/#port-blocking，取用日期：2026-11-08。
export const FORBIDDEN_PORTS: ReadonlySet<number> = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77,
  79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135,
  137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531,
  532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720,
  1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667,
  6668, 6669, 6679, 6697, 10080,
]);

export function isForbiddenPort(port: number): boolean { return FORBIDDEN_PORTS.has(port); }

// 自动分配最多监听 attempts 次；每次遇到禁止端口均先确认关闭，再重新监听。
export async function listenAvoidingForbidden(server: Server, host: string, port: number, attempts = 20): Promise<number> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { server.off("error", onError); reject(error); };
      server.once("error", onError);
      try { server.listen(port, host, () => { server.off("error", onError); resolve(); }); }
      catch (error) { server.off("error", onError); reject(error); }
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new PaneError("invalidPort", "无法取得监听端口");
    if (!isForbiddenPort(address.port)) return address.port;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (port !== 0) break;
  }
  throw new PaneError("forbiddenPort", "无法分配浏览器允许访问的端口，请更换端口后重试");
}
