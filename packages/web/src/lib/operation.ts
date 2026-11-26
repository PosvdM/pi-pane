// 结果需要确定的一次操作（动作调用、向插件会话发消息）。首次请求和之后每次“查询结果”的返回都交给同一个对象结算，
// 查询入口在操作结束前始终指向它（plugin-api.md“幂等规则”）。不依赖浏览器接口，单测可以直接导入。

/**
 * 一次请求的结果：done 已执行；notRun 确定没有执行（被拒、失败、控制状态冲突、放弃了后续表单）；
 * pending 插件已受理、仍在处理（含服务端等待超时）；unknown 这次请求没有得到结果（断网、浏览器侧超时，查询时的请求错误）。
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
  /**
   * 一次请求：首次发出（query 为 false）和每次查询（query 为 true）都调用它，用同一个幂等键和同样的内容。
   * 查询时请求本身失败（断网、服务端拒绝这次请求等）应返回 unknown：失败的是这次查询，不是原操作。
   * 不应抛错；抛错按 unknown 处理。
   */
  attempt: (query: boolean) => Promise<OpStep>;
  pendingText: string;
  unknownText: string;
  text?: OpText;
}

/**
 * 结算规则（与主会话一致：没有确定送达就放回原文）：
 * - 首次请求：done 结束；其余结果（notRun、pending、unknown）都立即把原文放回输入框，只放一次。
 *   notRun 结束；pending 和 unknown 留下查询入口。
 * - 查询：done 结束，提示用户删去放回的文字；notRun 结束，只提示结果（原文已在输入框）；pending 保留入口；
 *   unknown 只说明这次查询没有成功，不结算原操作，入口保留。
 * 关掉查询入口或刷新页面只丢掉查询的机会，原文已在输入框里。插件最终受理时，输入框里会多出一份原文，由用户删除。
 */
export class Operation {
  readonly key: string;
  readonly source: string;
  private readonly options: OpOptions;
  private readonly host: OpHost;
  private ended = false;
  private started = false;
  private last: OpState = "pending";
  /** 原文是否已放回输入框（只放一次）。 */
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
      const query = this.started; this.started = true;
      this.running = (async () => {
        let step: OpStep;
        try { step = await this.options.attempt(query); }
        catch (error) { step = { state: "unknown", message: (error as Error)?.message ?? String(error) }; }
        if (query) this.settleQuery(step); else this.settleFirst(step);
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

  private finish(state: OpState): void { this.ended = true; this.last = state; this.host.hide(this.key); }

  private settleFirst(step: OpStep): void {
    if (step.state === "done") {
      this.finish("done");
      if (step.message) this.host.toast(step.message);
      return;
    }
    this.putBack();
    switch (step.state) {
      case "notRun":
        this.finish("notRun");
        if (step.message) this.host.toast(step.message, "error");
        return;
      case "pending":
        this.last = "pending"; this.track("pending", step.message ?? this.options.pendingText);
        return;
      case "unknown":
        this.last = "unknown"; this.track("unknown", this.options.unknownText);
        if (step.message) this.host.toast(step.message, "error");
        return;
    }
  }

  private settleQuery(step: OpStep): void {
    switch (step.state) {
      case "done":
        this.finish("done");
        if (step.message) this.host.toast(step.message);
        if (this.textBack) this.host.toast("已送达，请删去输入框里放回的文字");
        return;
      case "notRun":
        this.finish("notRun");
        if (step.message) this.host.toast(step.message, "error");
        return;
      case "pending":
        this.last = "pending"; this.track("pending", step.message ?? this.options.pendingText);
        return;
      case "unknown":
        // 失败的是这次查询：入口和原操作的状态不变，稍后可以再查。
        this.host.toast(`这次查询没有成功${step.message ? "（" + step.message + "）" : ""}，结果仍未确定，可以稍后再查`, "error");
        return;
    }
  }
}
