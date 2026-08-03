/**
 * Polite HTTP for ATS feeds (§15).
 *
 * These endpoints are offered in good faith for syndication and cost their
 * operators real money. One request per second per host, an honest User-Agent
 * naming a contact URL, `Retry-After` respected when given, and exponential
 * backoff on 429/5xx.
 *
 * Sleeping is injected so tests exercise the backoff logic without spending the
 * wall-clock time it describes.
 */

export type FetchFailureKind =
  | "not_found"
  | "rate_limited"
  | "server_error"
  | "client_error"
  | "network"
  | "parse";

export class FetchFailure extends Error {
  override readonly name = "FetchFailure";
  readonly kind: FetchFailureKind;
  readonly status?: number;
  readonly url: string;

  constructor(kind: FetchFailureKind, url: string, message: string, status?: number) {
    super(message);
    this.kind = kind;
    this.url = url;
    if (status !== undefined) this.status = status;
  }
}

export type SleepFn = (ms: number) => Promise<void>;

export const realSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export interface PoliteFetcherOptions {
  /** Names the app and a contact URL, per §15. */
  readonly userAgent: string;
  readonly minIntervalMs?: number;
  readonly maxRetries?: number;
  readonly baseBackoffMs?: number;
  /** Upper bound on any single wait, so a hostile Retry-After cannot park a run. */
  readonly maxBackoffMs?: number;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: SleepFn;
}

export function buildUserAgent(contactUrl: string, version = "0.1"): string {
  return `job-radar/${version} (+${contactUrl})`;
}

export class PoliteFetcher {
  readonly #userAgent: string;
  readonly #minIntervalMs: number;
  readonly #maxRetries: number;
  readonly #baseBackoffMs: number;
  readonly #maxBackoffMs: number;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #sleep: SleepFn;
  /** Per-host serialization: each request chains behind the previous one. */
  readonly #hostQueues = new Map<string, Promise<void>>();

  constructor(options: PoliteFetcherOptions) {
    this.#userAgent = options.userAgent;
    this.#minIntervalMs = options.minIntervalMs ?? 1000;
    this.#maxRetries = options.maxRetries ?? 3;
    this.#baseBackoffMs = options.baseBackoffMs ?? 1000;
    this.#maxBackoffMs = options.maxBackoffMs ?? 60_000;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#sleep = options.sleep ?? realSleep;
  }

  /**
   * Serialize requests to a host and space them by at least minIntervalMs.
   * Concurrency across different hosts is unaffected.
   */
  async #withHostSlot<T>(host: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#hostQueues.get(host) ?? Promise.resolve();
    let release!: () => void;
    const slot = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#hostQueues.set(host, previous.then(() => slot));

    await previous;
    try {
      return await fn();
    } finally {
      // Hold the slot for the politeness interval before letting the next
      // request for this host proceed.
      this.#sleep(this.#minIntervalMs).then(release);
    }
  }

  #retryAfterMs(response: Response, attempt: number): number {
    const header = response.headers.get("retry-after");
    if (header !== null) {
      const seconds = Number(header);
      if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.min(seconds * 1000, this.#maxBackoffMs);
      }
      const date = Date.parse(header);
      if (!Number.isNaN(date)) {
        return Math.min(Math.max(date - Date.now(), 0), this.#maxBackoffMs);
      }
    }
    return Math.min(this.#baseBackoffMs * 2 ** attempt, this.#maxBackoffMs);
  }

  async fetchText(url: string, accept = "application/json"): Promise<string> {
    const host = new URL(url).host;

    return await this.#withHostSlot(host, async () => {
      let lastFailure: FetchFailure | null = null;

      for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
        if (attempt > 0 && lastFailure !== null) {
          await this.#sleep(Math.min(this.#baseBackoffMs * 2 ** (attempt - 1), this.#maxBackoffMs));
        }

        let response: Response;
        try {
          response = await this.#fetch(url, {
            headers: { "user-agent": this.#userAgent, accept },
            signal: AbortSignal.timeout(this.#timeoutMs),
            redirect: "follow",
          });
        } catch (error) {
          lastFailure = new FetchFailure(
            "network",
            url,
            error instanceof Error ? error.message : String(error),
          );
          continue;
        }

        if (response.ok) return await response.text();

        // Drain the body so the connection can be reused.
        await response.body?.cancel().catch(() => {});

        if (response.status === 404) {
          throw new FetchFailure(
            "not_found",
            url,
            "Board not found (404). The slug may have changed or the company may have moved ATS.",
            404,
          );
        }

        if (response.status === 429) {
          lastFailure = new FetchFailure("rate_limited", url, "Rate limited (429).", 429);
          if (attempt < this.#maxRetries) {
            await this.#sleep(this.#retryAfterMs(response, attempt));
          }
          continue;
        }

        if (response.status >= 500) {
          lastFailure = new FetchFailure(
            "server_error",
            url,
            `Upstream error (${response.status}).`,
            response.status,
          );
          continue;
        }

        throw new FetchFailure(
          "client_error",
          url,
          `Unexpected response (${response.status}).`,
          response.status,
        );
      }

      throw lastFailure ??
        new FetchFailure("network", url, "Request failed with no further detail.");
    });
  }

  async fetchJson<T>(url: string): Promise<T> {
    const body = await this.fetchText(url, "application/json");
    try {
      return JSON.parse(body) as T;
    } catch (error) {
      throw new FetchFailure(
        "parse",
        url,
        `Response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
