import type { Clock } from "../../src/util/clock.js";

export class FakeClock implements Clock {
  private ms: number;
  constructor(start = "2026-10-25T10:00:00.000Z") {
    this.ms = new Date(start).getTime();
  }
  now(): Date {
    return new Date(this.ms);
  }
  advance(ms: number): void {
    this.ms += ms;
  }
  set(iso: string): void {
    this.ms = new Date(iso).getTime();
  }
}
