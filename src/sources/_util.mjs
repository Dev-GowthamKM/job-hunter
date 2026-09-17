// Shared helpers for every lead source. Polite by default: real UA, timeouts, retries, backoff.
export const UA = 'JobHunter/1.0 (personal job-search tool; contact via project owner)';

/**
 * 429 is not a transient error and must not be retried like one.
 *
 * This used to treat "too many requests" exactly like a 500: three attempts, 1.2 seconds apart. So
 * the response to being told to slow down was to send three times as many requests, which is how a
 * modest increase in concurrency turned into an IP-level rate limit on Workable - the single most
 * important source in the pipeline.
 *
 * It now surfaces immediately with `.status` set, so the caller can stop the whole source rather
 * than grinding through four hundred more requests that will all be refused.
 */
export class RateLimited extends Error {
  constructor(url, retryAfter) {
    super(`rate limited${retryAfter ? `, retry after ${retryAfter}s` : ''}`);
    this.name = 'RateLimited';
    this.status = 429;
    this.retryAfter = retryAfter;
    this.url = url;
  }
}

export async function fetchWithRetry(url, { tries = 3, timeout = 25000, headers = {}, ...opts } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const ctl = AbortController ? new AbortController() : null;
    const timer = setTimeout(() => ctl?.abort(), timeout);
    try {
      const res = await fetch(url, { ...opts, headers: { 'User-Agent': UA, ...headers }, signal: ctl?.signal });
      clearTimeout(timer);
      if (res.status === 429) {
        const ra = Number(res.headers.get('retry-after')) || null;
        throw new RateLimited(url, ra);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof RateLimited) throw err;          // backing off means stopping, not retrying
      lastErr = err;
      if (i < tries - 1) await sleep(1200 * (i + 1));
    }
  }
  throw lastErr;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run `worker` over `items` with a fixed concurrency, preserving order in the result.
 *
 * hunt.mjs had this privately and used it for the 77 company boards, which is why those were never
 * the slow part. The query-driven sources did not, and Workable alone issues 67 searches - one per
 * track title - each paginating up to 8 deep. Sequentially that is 536 round trips and it was most
 * of a two-hour run.
 *
 * Concurrency here is not rudeness. The total number of requests is identical either way; the only
 * thing that changes is whether they are spread over two hours or a few minutes, and a crawler that
 * finishes is easier on a board than one that holds a connection open all morning.
 */
export async function pool(items, limit, worker) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (i < items.length) { const n = i++; out[n] = await worker(items[n], n); }
  }));
  return out;
}

/** HN and RSS bodies are HTML. Flatten to readable text so keyword matching and agents both work. */
export function stripHtml(html = '') {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'").replace(/&#x2F;/g, '/').replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const EMAIL_RE = /[a-zA-Z0-9._%+-]+(?:@| ?\[at\] ?| ?\(at\) ?| at )[a-zA-Z0-9.-]+(?:\.| ?\[dot\] ?| ?\(dot\) ?| dot )[a-zA-Z]{2,}/g;

/** People obfuscate emails on HN. Pull them out and normalize the common disguises. */
export function extractEmails(text = '') {
  const hits = text.match(EMAIL_RE) || [];
  return [...new Set(hits.map((e) => e
    .replace(/ ?\[at\] ?| ?\(at\) ?| at /gi, '@')
    .replace(/ ?\[dot\] ?| ?\(dot\) ?| dot /gi, '.')
    .trim().toLowerCase()
  ))].filter((e) => e.includes('@') && e.length < 80);
}

export function firstUrl(text = '') {
  const m = text.match(/https?:\/\/[^\s<>")\]]+/);
  return m ? m[0].replace(/[.,;:]$/, '') : null;
}

/** Score how well a body matches the configured offer keywords. Returns {offer, hits, negative}. */
export function matchOffer(text, keywords) {
  const t = (text || '').toLowerCase();
  const negative = (keywords.negative || []).filter((k) => t.includes(k));
  const score = (list) => (list || []).filter((k) => t.includes(k));
  const buckets = {
    agents: score(keywords.agents),
    automation: score(keywords.automation),
    website: score(keywords.website),
  };
  const best = Object.entries(buckets).sort((a, b) => b[1].length - a[1].length)[0];
  return {
    offer: best[1].length ? best[0] : null,
    hits: buckets,
    contractSignals: score(keywords.contractSignals),
    negative,
  };
}
