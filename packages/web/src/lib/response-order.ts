/**
 * 同一资源的并发请求按发出顺序编号，响应比已采用的结果新时才采用。
 * 先发的请求晚到时不覆盖后发请求已采用的结果；后发的请求失败时不撤销已采用的结果，
 * 只在失败比已采用的成功更新时报告错误。
 */
export class ResponseOrder {
  #issued = 0;
  #adopted = 0;
  #failed = 0;
  #pending = 0;

  /** 发出请求，返回其序号。 */
  begin(): number {
    this.#pending++;
    return ++this.#issued;
  }

  /** 请求成功；比已采用的结果新时返回 true，调用方据此采用响应。 */
  succeed(seq: number): boolean {
    this.#pending--;
    if (seq <= this.#adopted) return false;
    this.#adopted = seq;
    return true;
  }

  /** 请求失败；比已采用的结果新时返回 true，调用方据此显示错误，已采用的结果保持不变。 */
  fail(seq: number): boolean {
    this.#pending--;
    if (seq <= this.#adopted) return false;
    this.#failed = Math.max(this.#failed, seq);
    return true;
  }

  /** 还有请求未结束。 */
  get pending(): boolean {
    return this.#pending > 0;
  }

  /** 最近一次报告的失败比已采用的成功新，错误仍应显示。 */
  get failedSinceAdopted(): boolean {
    return this.#failed > this.#adopted;
  }
}
