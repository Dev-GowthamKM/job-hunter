// Hacker News via the Algolia API. Free, no key.
// Two very different veins are mined here:
//   1. "Ask HN: Freelancer? Seeking freelancer?" — the SEEKING FREELANCER comments are people with
//      budget looking to hire right now. This is the highest-intent free source that exists.
//   2. "Ask HN: Who is hiring?" — companies whose job posts reveal an AI/automation problem worth
//      solving as a contract instead of a hire.
import { fetchWithRetry, stripHtml, extractEmails, firstUrl, matchOffer, sleep } from './_util.mjs';

const ALGOLIA = 'https://hn.algolia.com/api/v1';

async function latestThreads() {
  const threads = [];

  // The freelancer thread is posted by a regular user (currently jon_north), NOT the whoishiring
  // account, so it has to be found by title.
  const freelance = await fetchWithRetry(
    `${ALGOLIA}/search_by_date?tags=story&query=${encodeURIComponent('"Freelancer? Seeking freelancer?"')}&hitsPerPage=3`
  ).then((r) => r.json());
  for (const h of freelance.hits || []) {
    if (/freelancer/i.test(h.title || '')) threads.push({ id: h.objectID, title: h.title, kind: 'freelance' });
  }

  const hiring = await fetchWithRetry(
    `${ALGOLIA}/search_by_date?tags=story,author_whoishiring&hitsPerPage=6`
  ).then((r) => r.json());
  for (const h of hiring.hits || []) {
    // "Who wants to be hired" is job seekers, i.e. your competition. Skip it.
    if (/who is hiring/i.test(h.title || '')) threads.push({ id: h.objectID, title: h.title, kind: 'hiring' });
  }

  // Only the two most recent of each kind stay relevant.
  const take = (kind, n) => threads.filter((t) => t.kind === kind).slice(0, n);
  return [...take('freelance', 2), ...take('hiring', 2)];
}

export async function collect(cfg) {
  const leads = [];
  const kw = cfg.keywords;
  const threads = await latestThreads();

  for (const thread of threads) {
    let item;
    try {
      item = await fetchWithRetry(`${ALGOLIA}/items/${thread.id}`, { timeout: 30000 }).then((r) => r.json());
    } catch {
      continue;
    }
    await sleep(400);

    for (const c of item.children || []) {
      if (!c.text || !c.author) continue;
      const text = stripHtml(c.text);
      if (text.length < 40) continue;

      if (thread.kind === 'freelance') {
        // In this thread the post declares intent up front. SEEKING WORK is a competing freelancer,
        // and as of late 2026 that is almost the whole thread, so real hits here are rare but golden.
        const head = text.slice(0, 200).toUpperCase();
        if (!head.includes('SEEKING FREELANCER')) continue;
      } else {
        // People post "seeking work" in the hiring thread every month. Those are job seekers,
        // i.e. competitors, and they arrive looking exactly like a company post until you read
        // the tell-tale lines. Verified: leads 23 and 42 were candidates scraped as clients.
        if (/^\s*(seeking work|seeking employment)/i.test(text)) continue;
        if (/willing to relocate\s*:/i.test(text.slice(0, 400))) continue;
        if (/^\s*location\s*:/i.test(text) && /r[ée]sum[ée]|\bcv\b/i.test(text.slice(0, 600))) continue;

        // Only posts that smell like the three offers are worth a look.
        const m = matchOffer(text, kw);
        if (!m.offer) continue;
        if (m.negative.length) continue;
      }

      const m = matchOffer(text, kw);
      const emails = extractEmails(text);
      const firstLine = text.split('\n')[0].slice(0, 160);

      // Who-is-hiring returns hundreds of posts a month. Rank before the run cap trims them, so the
      // ones that survive are the ones that would actually hire a contractor.
      const offerHits = (m.hits[m.offer] || []).length;
      const relevance = (thread.kind === 'freelance' ? 100 : 0)
        + m.contractSignals.length * 12
        + offerHits * 5
        + (emails.length ? 6 : 0);

      leads.push({
        source: 'hn',
        source_id: `hn:${c.id}`,
        title: firstLine,
        url: `https://news.ycombinator.com/item?id=${c.id}`,
        company: firstLine.split('|')[0].trim().slice(0, 80) || null,
        contact: emails[0] || firstUrl(text) || `https://news.ycombinator.com/user?id=${c.author}`,
        location: (firstLine.match(/\|\s*([^|]*(?:remote|onsite|hybrid)[^|]*)\s*\|/i) || [])[1]?.trim() || null,
        raw: {
          thread: thread.title,
          threadKind: thread.kind,
          author: c.author,
          body: text.slice(0, 4000),
          emails,
          suggestedOffer: m.offer,
          keywordHits: m.hits,
          contractSignals: m.contractSignals,
          relevance,
        },
      });
    }
  }
  // Best-first, so the scout's per-run cap keeps the good ones.
  return leads.sort((a, b) => b.raw.relevance - a.raw.relevance);
}
