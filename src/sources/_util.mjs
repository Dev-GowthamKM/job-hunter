// Shared helpers for every lead source. Polite by default: real UA, timeouts, retries, backoff.
export const UA = 'JobHunter/1.0 (personal job-search tool; contact via project owner)';

export async function fetchWithRetry(url, { tries = 3, timeout = 25000, headers = {}, ...opts } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const ctl = AbortController ? new AbortController() : null;
    const timer = setTimeout(() => ctl?.abort(), timeout);
    try {
      const res = await fetch(url, { ...opts, headers: { 'User-Agent': UA, ...headers }, signal: ctl?.signal });
      clearTimeout(timer);
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (i < tries - 1) await sleep(1200 * (i + 1));
    }
  }
  throw lastErr;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
