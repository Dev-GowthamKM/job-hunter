// Remotive public API. Free, no key.
//   https://remotive.com/api/remote-jobs
//
// Worth having for one field alone: `candidate_required_location`. It is the only board that states
// the eligibility answer as data instead of burying it in prose, and "Worldwide" there is the exact
// thing this whole pipeline is looking for.
import { fetchWithRetry, stripHtml } from '../../sources/_util.mjs';

const API = 'https://remotive.com/api/remote-jobs';

export async function collect() {
  const { jobs = [] } = await fetchWithRetry(API, { timeout: 40000 }).then((r) => r.json());

  return jobs.map((j) => {
    const req = (j.candidate_required_location || '').trim();
    const remote_scope = /^(worldwide|anywhere)$/i.test(req) ? 'worldwide'
      : /india|apac|asia/i.test(req) ? 'region'
      : req ? 'country' : 'unknown';

    return {
      source: 'remotive',
      source_id: `remotive:${j.id}`,
      company: j.company_name || null,
      company_tier: 'watch',                            // not in the curated registry; scored lower
      title: (j.title || '').trim(),
      url: j.url,
      apply_url: j.url,
      location_raw: req || 'Remote',
      employment_type: /full[_ -]?time/i.test(j.job_type || '') ? 'FullTime'
        : /part[_ -]?time/i.test(j.job_type || '') ? 'PartTime'
        : /contract/i.test(j.job_type || '') ? 'Contract'
        : /intern/i.test(j.job_type || '') ? 'Intern' : 'unknown',
      remote_scope,
      remote_detail: req,
      posted_at: j.publication_date || null,
      content: stripHtml(j.description || '').slice(0, 20000),
      salary_source: 'unknown',
      raw: { category: j.category, tags: j.tags, salaryText: j.salary || null },
    };
  });
}
