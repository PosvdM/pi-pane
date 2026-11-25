// 结果需要确定的一次操作（动作调用、向插件会话发消息）。首次请求和之后每次“查询结果”的返回都交给同一个对象结算，
// 查询入口在操作结束前始终指向它（plugin-api.md“幂等规则”）。不依赖浏览器接口，单测可以直接导入。

/**
 * 一次请求的结果：done 已执行；notRun 确定没有执行（被拒、失败、控制状态冲突、放弃了后续表单）；
 * pending 插件已受理、仍在处理；unknown 浏览器侧超时或断网，结果未知。
 */
export type OpState = "done" | "notRun" | "pending" | "unknown";
export interface OpStep { state: OpState; message?: string }

/** 界面上的“查询结果”入口。query 始终调用同一个操作对象。 */
export interface OpEntry { key: string; source: string; state: "pending" | "unknown"; message: string; query: () => Promise<OpState> }

export interface OpHost {
  /** 显示或更新查询入口（按 key 替换）。 */
  show(entry: OpEntry): void;
  hide(key: string): void;
  toast(message: string, level?: "error"): void;
}

/** 提交时移出输入框的原文；restore 把它放回输入框（放在当前内容之前）。 */
export interface OpText { restore(): void }

export interface OpOptions {
  /** 操作的标识，也是查询入口的 key；请求实际使用的幂等键可能随后续表单变化，由 attempt 自己管理。 */
  key: string;
  source: string;
  /** 一次请求：首次发出和每次查询都调用它，用同一个幂等键和同样的内容。不应抛错；抛错按结果未知处理。 */
  attempt: () => Promise<OpStep>;
  pendingText: string;
  unknownText: string;
  text?: OpText;
}

/**
 * 结算规则：
 * - done：结束；原文已放回过时提示用户删去。
 * - notRun：结束；原文不在输入框时放回（只放一次）。
 * - pending：保留查询入口，原文状态不变。
 * - unknown：保留查询入口；原文不在输入框时放回，提示与实际一致。
 */
export class Operation {
  readonly key: string;
  readonly source: string;
  private readonly options: OpOptions;
  private readonly host: OpHost;
  private ended = false;
  private last: OpState = "pending";
  /** 原文现在是否在输入框里（放回过一次后为 true）。 */
  private textBack = false;
  private running: Promise<OpState> | null = null;
  private readonly entryQuery = () => this.run();

  constructor(options: OpOptions, host: OpHost) {
    this.options = options; this.host = host; this.key = options.key; this.source = options.source;
  }

  get done(): boolean { return this.ended; }

  /** 发出一次请求（首次或查询）并结算。同一时刻只进行一次：连续点击“查询结果”时共用进行中的那次。 */
  run(): Promise<OpState> {
    if (this.ended) return Promise.resolve(this.last);
    if (!this.running) {
      this.running = (async () => {
        let step: OpStep;
        try { step = await this.options.attempt(); }
        catch (error) { this.host.toast((error as Error)?.message ?? String(error), "error"); step = { state: "unknown" }; }
        this.settle(step);
        return step.state;
      })().finally(() => { this.running = null; });
    }
    return this.running;
  }

  private putBack(): void {
    if (this.textBack || !this.options.text) return;
    this.textBack = true;
    this.options.text.restore();
  }

  private track(state: "pending" | "unknown", message: string): void {
    const note = this.textBack ? "，文字已放回输入框" : "";
    this.host.show({ key: this.key, source: this.source, state, message: message + note, query: this.entryQuery });
  }

  private settle(step: OpStep): void {
    if (this.ended) return;
    this.last = step.state;
    switch (step.state) {
      case "done":
        this.ended = true; this.host.hide(this.key);
        if (step.message) this.host.toast(step.message);
        if (this.textBack) this.host.toast("已送达，请删去输入框里放回的文字");
        return;
      case "notRun":
        this.ended = true; this.host.hide(this.key);
        this.putBack();
        if (step.message) this.host.toast(step.message, "error");
        return;
      case "pending":
        this.track("pending", step.message ?? this.options.pendingText);
        return;
      case "unknown":
        this.putBack();
        this.track("unknown", step.message ?? this.options.unknownText);
        return;
    }
  }
}
