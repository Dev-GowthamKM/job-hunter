// Arbeitnow job board feed. Free, no key.
//   https://www.arbeitnow.com/api/job-board-api
//
// EU-heavy and substantially German, so most of what it returns is geographically useless to someone
// outside Europe. It stays in because it costs one request and occasionally carries a genuinely
// worldwide remote role that no other feed has.
import { fetchWithRetry, stripHtml } from '../../sources/_util.mjs';

const API = 'https://www.arbeitnow.com/api/job-board-api';

export async function collect() {
  let body;
  try { body = await fetchWithRetry(API, { timeout: 40000 }).then((r) => r.json()); }
  catch { return []; }

  return (body.data || []).map((j) => {
    const types = j.job_types || [];
    return {
      source: 'arbeitnow',
      source_id: `arbeitnow:${j.slug}`,
      company: j.company_name || null,
      company_tier: 'watch',
      title: (j.title || '').trim(),
      url: j.url,
      apply_url: j.url,
      location_raw: j.location || (j.remote ? 'Remote' : ''),
      // `remote: true` with a named city is a local remote job, not a global one. Left as unknown so
      // eligibility.mjs reads the location field and decides, rather than trusting the flag.
      remote_scope: j.remote ? 'unknown' : 'onsite',
      remote_detail: [j.remote ? 'remote' : 'on-site', j.location].filter(Boolean).join(' | '),
      employment_type: types.some((t) => /full[- ]?time|vollzeit/i.test(t)) ? 'FullTime'
        : types.some((t) => /part[- ]?time|teilzeit/i.test(t)) ? 'PartTime'
        : types.some((t) => /freelance|contract/i.test(t)) ? 'Contract'
        : types.some((t) => /intern|praktik/i.test(t)) ? 'Intern' : 'unknown',
      posted_at: j.created_at ? new Date(j.created_at * 1000).toISOString() : null,
      content: stripHtml(j.description || '').slice(0, 20000),
      salary_source: 'unknown',
      raw: { tags: j.tags, job_types: types, remote: j.remote },
    };
  });
}
