/**
 * Time is injected. Tests must not depend on wall time (§4).
 */

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** A clock that stands still until you move it. */
export class FixedClock implements Clock {
  #current: Date;

  constructor(start: Date | string) {
    this.#current = typeof start === "string" ? new Date(start) : new Date(start);
  }

  now(): Date {
    return new Date(this.#current);
  }

  set(next: Date | string): void {
    this.#current = typeof next === "string" ? new Date(next) : new Date(next);
  }

  advance(ms: number): void {
    this.#current = new Date(this.#current.getTime() + ms);
  }
}
