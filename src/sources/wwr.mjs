// WeWorkRemotely category RSS. Free, no key. Titles arrive as "Company: Position".
import { fetchWithRetry, stripHtml, matchOffer } from './_util.mjs';

const FEEDS = [
  'https://weworkremotely.com/categories/remote-programming-jobs.rss',
  'https://weworkremotely.com/categories/remote-devops-sysadmin-jobs.rss',
  'https://weworkremotely.com/categories/remote-design-jobs.rss',
];

/** Minimal RSS item parser. The feeds are small and well-formed, so a real XML dep is not worth it. */
function parseItems(xml) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, block]) => {
    const pick = (tag) => {
      const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
      if (!m) return null;
      return m[1].replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim();
    };
    return { title: pick('title'), link: pick('link'), description: pick('description'), pubDate: pick('pubDate'), guid: pick('guid') };
  });
}

export async function collect(cfg) {
  const kw = cfg.keywords;
  const leads = [];

  for (const feed of FEEDS) {
    let xml;
    try { xml = await fetchWithRetry(feed).then((r) => r.text()); } catch { continue; }

    for (const it of parseItems(xml)) {
      if (!it.title || !it.link) continue;
      const body = stripHtml(it.description || '');
      const m = matchOffer(`${it.title} ${body}`, kw);
      if (!m.offer || m.negative.length) continue;

      const [company, ...rest] = it.title.split(':');
      const position = rest.join(':').trim() || it.title;
      const id = (it.guid || it.link).split('/').filter(Boolean).pop();

      leads.push({
        source: 'wwr',
        source_id: `wwr:${id}`,
        title: it.title.slice(0, 160),
        url: it.link,
        company: rest.length ? company.trim() : null,
        contact: it.link,
        location: 'Remote',
        raw: {
          position, posted: it.pubDate, body: body.slice(0, 3000),
          suggestedOffer: m.offer, keywordHits: m.hits, contractSignals: m.contractSignals,
          relevance: (m.hits[m.offer] || []).length * 5 + m.contractSignals.length * 12,
        },
      });
    }
  }
  return leads.sort((a, b) => b.raw.relevance - a.raw.relevance);
}
