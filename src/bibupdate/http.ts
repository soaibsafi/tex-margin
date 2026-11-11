/**
 * Small HTTP client for the metadata sources. 
 * Per-host pacing (DBLP blocks clients that send more than about one request a second), timeouts, cancellation, a short cache, and readable errors.
 */

export type FetchFn = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface Response {
  status: number;
  contentType: string;
  text: string;
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** No answer at all (refused, offline, timeout): another mirror may still work. */
    readonly unreachable = false,
  ) {
    super(message);
  }
}

/** Node's fetch only says "fetch failed"; the reason is in `cause`. */
function networkReason(e: unknown): string {
  const cause = (e as { cause?: { code?: string; message?: string } })?.cause;
  const code = cause?.code ?? '';
  if (code === 'ECONNREFUSED') return 'connection refused';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'host not found; are you offline?';
  if (code === 'ECONNRESET') return 'connection reset';
  if (/TIMEOUT/.test(code)) return 'connection timed out';
  if (/CERT|SSL|TLS/.test(code)) return `certificate problem (${code}); a proxy may be intercepting HTTPS`;
  return cause?.message ?? (e instanceof Error ? e.message : String(e));
}

export interface GetOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

const TIMEOUT_MS = 20000;
const CACHE_MS = 10 * 60 * 1000;

export class Http {
  private readonly next = new Map<string, number>();
  private readonly gaps = new Map<string, number>();
  private readonly cache = new Map<string, { at: number; response: Response }>();

  constructor(
    private readonly userAgent: string,
    private fetchFn: FetchFn = globalThis.fetch as unknown as FetchFn,
  ) {}

  /** Minimum time between two requests to `host`. */
  pace(host: string, ms: number): void {
    this.gaps.set(host, Math.max(ms, this.gaps.get(host) ?? 0));
  }

  setFetch(fn: FetchFn): void {
    this.fetchFn = fn;
    this.cache.clear();
  }

  /** GET `url`; throws `HttpError` for anything but 2xx. */
  async get(url: string, options: GetOptions = {}): Promise<Response> {
    const cached = this.cache.get(url);
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.response;

    const host = new URL(url).host;
    const gap = this.gaps.get(host) ?? 0;
    const wait = Math.max(0, (this.next.get(host) ?? 0) - Date.now());
    this.next.set(host, Date.now() + wait + gap);
    if (wait) await delay(wait, options.signal);

    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let res: Awaited<ReturnType<FetchFn>>;
    try {
      res = await this.fetchFn(url, { headers: { 'User-Agent': this.userAgent, ...options.headers }, signal });
    } catch (e) {
      if (options.signal?.aborted) throw e;
      if (timeout.aborted) throw new HttpError(`${host} did not answer within ${TIMEOUT_MS / 1000} s`, undefined, true);
      throw new HttpError(`could not reach ${host}: ${networkReason(e)}`, undefined, true);
    }
    const response = { status: res.status, contentType: res.headers.get('content-type') ?? '', text: await res.text() };
    if (res.status === 429) throw new HttpError(`${host} is rate-limiting requests; try again in a minute`, 429);
    if (res.status === 404) throw new HttpError(`not found on ${host}`, 404);
    if (res.status < 200 || res.status >= 300) throw new HttpError(`${host} answered ${res.status}`, res.status);
    this.cache.set(url, { at: Date.now(), response });
    return response;
  }

  async json<T>(url: string, options?: GetOptions): Promise<T> {
    const res = await this.get(url, options);
    if (!/json/i.test(res.contentType) && !/^\s*[[{]/.test(res.text)) {
      throw new HttpError(/not a bot|anubis|challenge/i.test(res.text) ? `${new URL(url).host}'s bot check blocked the request` : `${new URL(url).host} did not return JSON`);
    }
    return JSON.parse(res.text) as T;
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(signal.reason);
    });
  });
}
