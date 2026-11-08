// 跨组件的小操作：导出下载、侧栏开关。
import { request } from "./api.ts";
import { Store } from "./store.ts";
import { toast } from "./ui-state.ts";

export const sidebarOpen = new Store<boolean>(true);

export async function downloadExport(exportId: string): Promise<void> {
  try {
    const blob = await (await request(`/api/exports/${encodeURIComponent(exportId)}`)).blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "pi-session.html"; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    toast("已导出");
  } catch (error) { toast((error as Error).message, "error"); }
}
