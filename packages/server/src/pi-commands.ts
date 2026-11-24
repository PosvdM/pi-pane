// 依据 pi 1.5.0 docs/slash-commands.md、dist/core/slash-commands.js 的内置命令列表，
// 以及 dist/modes/interactive/interactive-mode.js 的隐藏交互命令；排除 pi-pane 自行实现的命令。
// llama、mcp 也在 pi 文档中列出；已加载的同名资源命令由 get_commands 优先确认。
const terminalOnlyCommands = new Set([
  "settings", "tree", "scoped-models", "import", "share", "bug", "copy", "changelog", "hotkeys",
  "trust", "login", "logout", "reload", "llama", "mcp", "debug", "arminsayshi", "dementedelves",
]);

export function terminalOnlyCommand(message: string): string | undefined {
  const name = /^\/([^\s]+)/.exec(message.trimStart())?.[1];
  return name && terminalOnlyCommands.has(name) ? name : undefined;
}
