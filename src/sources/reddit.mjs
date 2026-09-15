// Reddit — DISABLED by default.
// Verified 2026-09: both https://reddit.com/r/<sub>/new.json and the .rss feed now return 403 to
// unauthenticated clients. Reddit requires a registered OAuth app. Registering one is free
// (https://www.reddit.com/prefs/apps, type "script"), and once REDDIT_CLIENT_ID and
// REDDIT_CLIENT_SECRET are in .env you can flip sources.reddit.enabled to true in config/targets.json.
import { stripHtml, matchOffer } from './_util.mjs';

const SUBS = ['forhire', 'slavelabour', 'SaaS', 'smallbusiness', 'Entrepreneur', 'automation'];

async function token() {
  const id = process.env.REDDIT_CLIENT_ID, secret = process.env.REDDIT_CLIENT_SECRET;
  if (!id || !secret) throw new Error('Reddit source needs REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET in .env');
  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'JobHunter/1.0',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`Reddit auth failed: HTTP ${res.status}`);
  return (await res.json()).access_token;
}

export async function collect(cfg) {
  const kw = cfg.keywords;
  const t = await token();
  const leads = [];

  for (const sub of SUBS) {
    const res = await fetch(`https://oauth.reddit.com/r/${sub}/new?limit=50`, {
      headers: { Authorization: `Bearer ${t}`, 'User-Agent': 'JobHunter/1.0' },
    });
    if (!res.ok) continue;
    const json = await res.json();

    for (const { data: p } of json.data?.children || []) {
      const text = `${p.title} ${stripHtml(p.selftext || '')}`;
      // In r/forhire, [Hiring] is a client and [For Hire] is a competitor.
      if (sub === 'forhire' && !/\[hiring\]/i.test(p.title)) continue;
      const m = matchOffer(text, kw);
      if (!m.offer || m.negative.length) continue;

      leads.push({
        source: 'reddit',
        source_id: `reddit:${p.id}`,
        title: p.title.slice(0, 160),
        url: `https://reddit.com${p.permalink}`,
        company: null,
        contact: `https://reddit.com/u/${p.author}`,
        location: null,
        raw: {
          subreddit: sub, author: p.author, body: stripHtml(p.selftext || '').slice(0, 3000),
          suggestedOffer: m.offer, keywordHits: m.hits, contractSignals: m.contractSignals,
          relevance: (m.hits[m.offer] || []).length * 5 + m.contractSignals.length * 12,
        },
      });
    }
  }
  return leads.sort((a, b) => b.raw.relevance - a.raw.relevance);
}
