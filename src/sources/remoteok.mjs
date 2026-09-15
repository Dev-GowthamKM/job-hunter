// RemoteOK public JSON API. Free, no key.
// ATTRIBUTION: RemoteOK's API terms require a dofollow link back to remoteok.com wherever these
// listings are displayed. Every lead carries the canonical URL for that reason.
import { fetchWithRetry, stripHtml, matchOffer } from './_util.mjs';

export const ATTRIBUTION = 'Jobs sourced from <a href="https://remoteok.com">Remote OK</a>';

export async function collect(cfg) {
  const kw = cfg.keywords;
  const rows = await fetchWithRetry('https://remoteok.com/api').then((r) => r.json());
  const leads = [];

  for (const j of rows) {
    if (!j.id || !j.position) continue;          // rows[0] is RemoteOK's legal notice, not a job
    // Join tags with a separator, never a space: RemoteOK ships tags like ["ops","engineer"],
    // and a space join invents the phrase "ops engineer" across two unrelated tags. That is how a
    // Plant Fitter listing scored as an automation lead.
    const text = [j.position, j.company, (j.tags || []).join(' | '), stripHtml(j.description || '')].join(' | ');
    const m = matchOffer(text, kw);
    if (!m.offer || m.negative.length) continue;

    const salary = j.salary_max ? `$${j.salary_min || 0}-${j.salary_max}` : null;
    leads.push({
      source: 'remoteok',
      source_id: `remoteok:${j.id}`,
      title: `${j.company || 'Unknown'} — ${j.position}`,
      url: j.url || `https://remoteok.com/remote-jobs/${j.slug || j.id}`,
      company: j.company || null,
      contact: j.apply_url || j.url || null,
      location: j.location || 'Remote',
      raw: {
        position: j.position,
        tags: j.tags || [],
        salary,
        posted: j.date,
        body: stripHtml(j.description || '').slice(0, 3000),
        suggestedOffer: m.offer,
        keywordHits: m.hits,
        contractSignals: m.contractSignals,
        relevance: (m.hits[m.offer] || []).length * 5 + m.contractSignals.length * 12 + (salary ? 5 : 0),
        attribution: ATTRIBUTION,
      },
    });
  }
  return leads.sort((a, b) => b.raw.relevance - a.raw.relevance);
}
