// Lever public postings API. Free, no key.
//   https://api.lever.co/v0/postings/<slug>?mode=json
//
// Lever slugs are unguessable - most company names 404 - so an unknown slug must fail quietly and
// let the run continue. The registry only contains slugs that were verified live.
import { fetchWithRetry, stripHtml } from '../../sources/_util.mjs';

const API = (slug) => `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`;

export async function collect(cfg, { slug, company } = {}) {
  let rows;
  try {
    rows = await fetchWithRetry(API(slug)).then((r) => r.json());
  } catch {
    return [];                                          // dead slug, not a run-ending error
  }
  if (!Array.isArray(rows)) return [];

  return rows.map((j) => {
    const c = j.categories || {};
    const content = stripHtml([j.descriptionPlain || j.description || '', ...(j.lists || []).map((l) => `${l.text}: ${stripHtml(l.content || '')}`)].join('\n\n'));
    const commitment = c.commitment || '';

    return {
      source: 'lever',
      source_id: `lever:${slug}:${j.id}`,
      company: company?.name || slug,
      company_tier: company?.tier || 'unknown',
      title: (j.text || '').trim(),
      url: j.hostedUrl,
      apply_url: j.applyUrl || j.hostedUrl,
      location_raw: [c.location, c.allLocations?.join(', ')].filter(Boolean).join(' | '),
      employment_type: /full[- ]?time/i.test(commitment) ? 'FullTime'
        : /part[- ]?time/i.test(commitment) ? 'PartTime'
        : /intern/i.test(commitment) ? 'Intern'
        : /contract/i.test(commitment) ? 'Contract' : 'unknown',
      remote_scope: /remote/i.test(c.location || '') ? 'unknown' : 'unknown',
      remote_detail: [c.workplaceType, c.location, ...(c.allLocations || [])].filter(Boolean).join(' | '),
      posted_at: j.createdAt ? new Date(j.createdAt).toISOString() : null,
      content: content.slice(0, 20000),
      salary_source: 'unknown',
      raw: { commitment, team: c.team, department: c.department },
    };
  });
}
