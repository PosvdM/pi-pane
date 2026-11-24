import type { IncomingMessage } from "node:http";
import type { ActionInvocation, SessionRef } from "@pi-pane/plugin-api";
import { assert, PaneError } from "../errors.js";
import { PluginHost } from "./host.js";

export const NOT_PLUGIN_ROUTE = Symbol("notPluginRoute");
export interface PluginHttpContext {
  host: PluginHost;
  request: IncomingMessage;
  url: URL;
  credential: string;
  body(): Promise<any>;
  assertAccepting(): void;
}

/** 所有入口由 PaneServer 先完成 Host、Origin 和浏览器凭证校验。 */
export async function pluginHttp(context: PluginHttpContext): Promise<unknown> {
  const { host, request, url, credential } = context;
  const pathname = url.pathname; const method = request.method;
  const body = async () => { const value = await context.body(); context.assertAccepting(); return value; };
  const origin = (value: any) => host.presence.origin(value.connectionId, credential);
  if (method === "GET" && pathname === "/api/plugins") return { plugins: host.runtime.list() };
  if (method === "GET" && pathname === "/api/forms") return { forms: host.operations.pending() };
  if (method === "GET" && pathname === "/api/banners/removable") return { banners: host.banners.removable() };
  if (method === "POST" && pathname === "/api/banners/remove") {
    const value = await body(); host.banners.removeOrphan(value.source, value.id, origin(value), value.confirmed); return { status: "done" };
  }
  const presence = pathname.match(/^\/api\/presence\/([^/]+)$/);
  if (method === "POST" && presence) {
    const value = await body(); const caller = origin(value);
    host.presence.respond(caller.connectionId, decodeURIComponent(presence[1]), value.response); return { status: "done" };
  }
  const route = pathname.match(/^\/api\/plugins\/([^/]+)\/(.+)$/);
  if (!route) return NOT_PLUGIN_ROUTE;
  const source = decodeURIComponent(route[1]); const operation = route[2];
  assert(source !== "pane", "reservedSource", "主会话使用 pane 自身的接口");
  if (method === "GET" && operation === "catalog") return host.catalog(source);
  if (method === "POST" && operation === "disable") { const value = await body(); origin(value); await host.runtime.stop(source); return { status: "done" }; }
  if (method === "POST" && operation === "tree/snapshot") {
    const value = await body();
    return host.treeSnapshot(source, { openNodeIds: value.openNodeIds ?? [], recentSince: value.recentSince ?? new Date(Date.now() - 7 * 86400000).toISOString() });
  }
  if (method === "GET" && operation === "tree/children") return host.treeChildren(source, url.searchParams.get("parentId") ?? "", {
    epoch: url.searchParams.get("epoch") ?? "", cursor: url.searchParams.get("cursor") ?? undefined, limit: Number(url.searchParams.get("limit") ?? 50),
  });
  if (method === "GET" && operation === "forms") return { forms: host.operations.pending(source) };
  const panel = operation.match(/^panels\/([^/]+)$/);
  if (method === "GET" && panel) return host.panel(source, decodeURIComponent(panel[1]), url.searchParams.get("nodeId") ?? undefined);
  const action = operation.match(/^actions\/([^/]+)\/(form|invoke)$/);
  if (method === "POST" && action) {
    const value = await body(); const actionId = decodeURIComponent(action[1]);
    if (action[2] === "form") return { form: await host.operations.resolveForm(source, actionId, value.target) };
    const caller = origin(value);
    const invocation: ActionInvocation = { actionId, idempotencyKey: value.idempotencyKey,
      ...(value.target === undefined ? {} : { target: value.target }), ...(value.input === undefined ? {} : { input: value.input }),
      ...(value.formId === undefined ? {} : { formId: value.formId }), ...(value.formRevision === undefined ? {} : { formRevision: value.formRevision }),
    };
    return host.operations.invoke(source, invocation, caller);
  }
  const form = operation.match(/^forms\/([^/]+)$/);
  if (method === "POST" && form) {
    const value = await body();
    return host.operations.submit(source, { formId: decodeURIComponent(form[1]), revision: value.revision, outcome: value.outcome, idempotencyKey: value.idempotencyKey }, origin(value));
  }
  const session = operation.match(/^sessions\/([^/]+)\/(snapshot|history|send|abort)$/);
  if (session) {
    const ref: SessionRef = { source, id: decodeURIComponent(session[1]) };
    if (method === "GET" && session[2] === "snapshot") return host.snapshot(ref);
    if (method === "GET" && session[2] === "history") return host.history(ref, url.searchParams.get("before") ?? "", Number(url.searchParams.get("limit") ?? 50));
    if (method === "POST" && session[2] === "send") {
      const value = await body();
      return host.operations.send(source, ref, value.input, { idempotencyKey: value.idempotencyKey, origin: origin(value), expectedRevision: value.expectedRevision });
    }
    if (method === "POST" && session[2] === "abort") {
      const value = await body(); const caller = origin(value);
      assert(value.clearQueue === true, "invalidAbort", "停止必须先清空待发队列");
      return host.runtime.call(source, "sessions.abort", (plugin) => {
        assert(plugin.sessions?.abort, "unsupportedCapability", "插件不支持停止", 404);
        return plugin.sessions.abort(ref, { clearQueue: true, origin: caller, expectedRevision: value.expectedRevision });
      });
    }
  }
  throw new PaneError("notFound", "插件接口不存在", 404);
}
