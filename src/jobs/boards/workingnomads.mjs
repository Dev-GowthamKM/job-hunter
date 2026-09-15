// Working Nomads. Free, no key.
//   https://www.workingnomads.com/api/exposed_jobs/
//
// Small feed, but unusually high signal for this pipeline: it states geography as prose that
// actually means something — "Remote (Worldwide)", "Global", "USA, Canada or UK only",
// "Time zone: CET (+/- 3 hours)" — so a genuinely worldwide role is recognisable rather than guessed.
import { fetchWithRetry, stripHtml } from '../../sources/_util.mjs';

const API = 'https://www.workingnomads.com/api/exposed_jobs/';

export async function collect() {
  let rows;
  try { rows = await fetchWithRetry(API, { timeout: 30000 }).then((r) => r.json()); }
  catch { return []; }
  if (!Array.isArray(rows)) return [];

  return rows.map((j) => {
    const loc = (j.location || '').trim();
    const remote_scope = /^(global|remote \(worldwide\)|worldwide|anywhere)$/i.test(loc) ? 'worldwide'
      : /worldwide|global/i.test(loc) && !/only/i.test(loc) ? 'worldwide'
      : loc ? 'country' : 'unknown';

    return {
      source: 'workingnomads',
      source_id: `workingnomads:${j.url}`,
      company: j.company_name || null,
      company_tier: 'watch',
      title: (j.title || '').trim(),
      url: j.url,
      apply_url: j.url,
      location_raw: loc || 'Remote',
      remote_scope,
      remote_detail: loc,
      employment_type: 'unknown',
      posted_at: j.pub_date || null,
      content: stripHtml(j.description || '').slice(0, 20000),
      salary_source: 'unknown',
      raw: { category: j.category_name, tags: j.tags },
    };
  });
}
