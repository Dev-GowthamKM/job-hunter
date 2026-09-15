// Greenhouse public board API. Free, no key.
//   https://boards-api.greenhouse.io/v1/boards/<slug>/jobs?content=true
//
// Greenhouse gives the full JD and the office list but no structured pay, so salary has to be read
// out of the HTML by eligibility.parseSalary. US pay-transparency law means most US postings do
// publish a range in the body; most non-US ones publish nothing at all.
import { fetchWithRetry, stripHtml } from '../../sources/_util.mjs';

const API = (slug) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`;

/** Greenhouse hosts a free-form metadata bag per board; "Location Type" is the useful one. */
function metaValue(job, name) {
  const hit = (job.metadata || []).find((m) => new RegExp(name, 'i').test(m.name || ''));
  const v = hit?.value;
  return Array.isArray(v) ? v.join(', ') : (v ?? null);
}

export async function collect(cfg, { slug, company } = {}) {
  const res = await fetchWithRetry(API(slug), { timeout: 40000 });
  const { jobs = [] } = await res.json();
  const out = [];

  for (const j of jobs) {
    // Greenhouse double-encodes the description as HTML entities inside HTML.
    const content = stripHtml(stripHtml(j.content || ''));
    const offices = (j.offices || []).map((o) => o.name).filter((n) => n && n !== 'No Office');
    const locationType = metaValue(j, 'location type') || metaValue(j, 'remote');
    const locationName = j.location?.name || '';

    const remote_scope = /on-?site/i.test(locationType || '') ? 'onsite'
      : /hybrid/i.test(locationType || '') ? 'onsite'
      : /remote/i.test(`${locationType} ${locationName}`) ? 'unknown'
      : 'unknown';

    out.push({
      source: 'greenhouse',
      source_id: `greenhouse:${slug}:${j.id}`,
      company: company?.name || j.company_name || slug,
      company_tier: company?.tier || 'unknown',
      title: (j.title || '').trim(),
      url: j.absolute_url,
      apply_url: j.absolute_url,
      location_raw: [locationName, ...offices].filter(Boolean).join(' | '),
      employment_type: 'unknown',                      // Greenhouse does not expose it; inferred later
      remote_scope,
      remote_detail: [locationType, locationName, ...offices].filter(Boolean).join(' | '),
      posted_at: j.first_published || j.updated_at || null,
      content: content.slice(0, 20000),
      salary_source: 'unknown',
      raw: { departments: (j.departments || []).map((d) => d.name), locationType, offices },
    });
  }
  return out;
}
