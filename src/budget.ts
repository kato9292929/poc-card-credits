import { microToUsd, type MicroUsd } from './money.ts';
import { jstDay } from './log.ts';

export type ReserveResult =
  | { ok: true; reservation: Reservation }
  | { ok: false; reason: 'per_call_cap' | 'daily_cap'; detail: string };

export interface Reservation {
  readonly amount: MicroUsd;
  /** 実際に支払いを送った（または送った可能性がある）。日次上限に計上したまま残す。 */
  commit(): void;
  /** 支払いを送らなかった。予約を解放する。 */
  release(): void;
}

/**
 * ゲートウェイのウォレットからの支出上限（1コール・1日）を強制する。
 * 署名する「前」に reserve() し、上限を超える支払いには署名しない。
 * 日の境界は JST（ログの日付と同じ）。プロセス再起動時は当日のログから支出済み額を復元する。
 */
export class SpendGuard {
  private day: string;
  private spent: MicroUsd;
  private reserved: MicroUsd = 0n;

  constructor(
    readonly maxPerCall: MicroUsd,
    readonly maxPerDay: MicroUsd,
    private readonly restore: (day: string) => MicroUsd = () => 0n,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.day = jstDay(this.now());
    this.spent = restore(this.day);
  }

  private rollover(): void {
    const today = jstDay(this.now());
    if (today !== this.day) {
      this.day = today;
      this.spent = this.restore(today);
      // 前日の未確定予約は前日分として扱い、新しい日には持ち越さない
      this.reserved = 0n;
    }
  }

  snapshot() {
    this.rollover();
    return { day: this.day, spent: this.spent, reserved: this.reserved, maxPerCall: this.maxPerCall, maxPerDay: this.maxPerDay };
  }

  reserve(amount: MicroUsd): ReserveResult {
    this.rollover();
    if (amount <= 0n) throw new Error('reserve amount must be > 0');
    if (amount > this.maxPerCall) {
      return { ok: false, reason: 'per_call_cap', detail: `requested $${microToUsd(amount)} > per-call cap $${microToUsd(this.maxPerCall)}` };
    }
    if (this.spent + this.reserved + amount > this.maxPerDay) {
      return {
        ok: false,
        reason: 'daily_cap',
        detail: `spent $${microToUsd(this.spent)} + in-flight $${microToUsd(this.reserved)} + $${microToUsd(amount)} > daily cap $${microToUsd(this.maxPerDay)}`,
      };
    }
    this.reserved += amount;
    const day = this.day;
    let done = false;
    const finish = (spend: boolean) => {
      if (done) return;
      done = true;
      if (this.day !== day) return; // 日付が変わった後の確定は前日分
      this.reserved -= amount;
      if (spend) this.spent += amount;
    };
    return { ok: true, reservation: { amount, commit: () => finish(true), release: () => finish(false) } };
  }
}
