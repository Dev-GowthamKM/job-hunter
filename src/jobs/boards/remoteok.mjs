// RemoteOK, in job-seeking mode. Free, no key.
//
// ATTRIBUTION: RemoteOK's API terms require a dofollow link back to remoteok.com wherever these
// listings are displayed, which is why every job keeps its canonical URL.
//
// Separate from src/sources/remoteok.mjs, which reads the same feed looking for people to SELL to.
// Same endpoint, opposite direction.
import { fetchWithRetry, stripHtml } from '../../sources/_util.mjs';

export const ATTRIBUTION = 'Jobs sourced from https://remoteok.com';

export async function collect() {
  let rows;
  try { rows = await fetchWithRetry('https://remoteok.com/api', { timeout: 30000 }).then((r) => r.json()); }
  catch { return []; }

  const out = [];
  for (const j of rows) {
    if (!j.id || !j.position) continue;                  // rows[0] is RemoteOK's legal notice
    const loc = (j.location || '').trim();
    const worldwide = /worldwide|anywhere|global/i.test(loc) || loc === '' || loc === 'Remote';

    out.push({
      source: 'remoteok',
      source_id: `remoteok-job:${j.id}`,
      company: j.company || null,
      company_tier: 'watch',
      title: (j.position || '').trim(),
      url: j.url || `https://remoteok.com/remote-jobs/${j.slug || j.id}`,
      apply_url: j.apply_url || j.url,
      location_raw: loc || 'Worldwide',
      remote_scope: worldwide ? 'worldwide' : 'country',
      remote_detail: loc,
      employment_type: 'unknown',
      salary_min: j.salary_min || null,
      salary_max: j.salary_max || null,
      salary_currency: j.salary_min ? 'USD' : null,
      salary_period: j.salary_min ? 'year' : null,
      salary_source: j.salary_min ? 'structured' : 'unknown',
      posted_at: j.date || null,
      content: stripHtml(j.description || '').slice(0, 20000),
      raw: { tags: j.tags || [], attribution: ATTRIBUTION },
    });
  }
  return out;
}
