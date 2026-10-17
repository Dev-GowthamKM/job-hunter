// We Work Remotely. Free, no key, RSS per category.
//   https://weworkremotely.com/categories/<category>.rss
//
// Worth polling for one reason: every posting carries a <region> field, and the board's own
// vocabulary includes "Anywhere in the World" as a distinct value from "USA Only" or "Europe Only".
// Almost every other source leaves geography to be inferred from prose; this one states it.
//
// The catch, and it is the usual one: the region field is what the EMPLOYER selected, and employers
// are generous with it. A posting tagged "Anywhere in the World" whose body says "this role can be
// filled in the Northeast or our San Francisco headquarters" is a US role with a mis-set dropdown.
// The region is taken as the location field, which means eligibility.mjs still reads the body and
// still gets the last word - exactly as it does for every other board.
//
// The feed returns 25 items per category, so coverage comes from polling several categories rather
// than paginating. Five categories is about 125 postings for five requests.
import { fetchWithRetry, stripHtml, pool } from '../../sources/_util.mjs';

const FEED = (c) => `https://weworkremotely.com/categories/${c}.rss`;

// Only the categories that map to a track. Sales, finance and customer support are not roles the
// owner is looking for, and polling them would be four more requests for nothing.
const CATEGORIES = [
  'remote-programming-jobs',
  'remote-devops-sysadmin-jobs',
  'remote-marketing-jobs',
  'remote-product-jobs',
  'remote-design-jobs',
];

/** Minimal XML field read. The feed is machine-generated and flat, so a parser would be overkill. */
const tag = (xml, name) => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i').exec(xml);
  return m ? m[1].trim() : '';
};

const unescapeXml = (s) => String(s)
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');

export async function collect() {
  const perCategory = await pool(CATEGORIES, 3, async (cat) => {
    try { return await fetchWithRetry(FEED(cat), { timeout: 25000 }).then((r) => r.text()); }
    catch { return ''; }
  });

  const out = [];
  const seen = new Set();

  for (const xml of perCategory) {
    for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
      const item = m[1];
      const link = unescapeXml(tag(item, 'link'));
      if (!link || seen.has(link)) continue;        // a job can sit in two categories
      seen.add(link);

      // The title is "Company: Role". Splitting on the first colon only, because plenty of roles
      // carry one of their own - "Engineer: Platform" would otherwise lose half its name.
      const rawTitle = unescapeXml(tag(item, 'title'));
      const at = rawTitle.indexOf(':');
      const company = at > 0 ? rawTitle.slice(0, at).trim() : null;
      const title = at > 0 ? rawTitle.slice(at + 1).trim() : rawTitle;

      const region = unescapeXml(tag(item, 'region'));
      const global = /anywhere in the world/i.test(region);

      out.push({
        source: 'weworkremotely',
        source_id: `wwr:${link}`,
        company,
        company_tier: 'watch',
        title,
        url: link,
        apply_url: link,
        // The region is the location field. Where it says anywhere, eligibility.mjs reads that as
        // the generic global token it is, and the body still has to agree.
        location_raw: region || 'Remote',
        remote_scope: global ? 'worldwide' : region ? 'country' : 'unknown',
        remote_detail: region,
        employment_type: 'unknown',
        posted_at: unescapeXml(tag(item, 'pubDate')) || null,
        content: stripHtml(unescapeXml(tag(item, 'description'))).slice(0, 20000),
        salary_source: 'unknown',
        raw: { category: unescapeXml(tag(item, 'category')), region },
      });
    }
  }
  return out;
}
