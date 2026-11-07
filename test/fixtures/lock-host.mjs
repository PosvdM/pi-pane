import { acquireSessionWriterLock, currentProcessIdentity, isSessionWriterLock } from "pi-hostkit";
const lock = await acquireSessionWriterLock(process.env.SESSION_FILE, { app: "pi-agora", identity: currentProcessIdentity("test-agora") });
if (!isSessionWriterLock(lock) || await lock.recoverPreviousWriter() === "failed") throw new Error("测试宿主未取得写锁");
process.send({ locked: true });
process.on("message", async () => { await lock.release(); process.exit(0); });
