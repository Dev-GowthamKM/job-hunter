// Jobicy remote job feed. Free, no key.
//   https://jobicy.com/api/v2/remote-jobs
//
// Structured geography, employment type, seniority and pay with a real currency and period. Small
// feed compared to Workable, but what it returns needs almost no parsing.
import { fetchWithRetry, stripHtml, sleep } from '../../sources/_util.mjs';

const API = 'https://jobicy.com/api/v2/remote-jobs';
// Jobicy segments by industry; these are the ones the owner's tracks land in.
const INDUSTRIES = ['marketing', 'dev', 'data-science', 'design-multimedia', 'business'];

export async function collect() {
  const out = [];
  const seen = new Set();

  for (const industry of INDUSTRIES) {
    let body;
    try { body = await fetchWithRetry(`${API}?count=50&industry=${industry}`, { timeout: 25000 }).then((r) => r.json()); }
    catch { continue; }

    for (const j of body.jobs || []) {
      if (!j.id || seen.has(j.id)) continue;
      seen.add(j.id);

      const geo = (j.jobGeo || '').trim();
      const remote_scope = /^(anywhere|worldwide)$/i.test(geo) ? 'worldwide'
        : /india|apac|asia/i.test(geo) ? 'region'
        : geo ? 'country' : 'unknown';

      const types = Array.isArray(j.jobType) ? j.jobType : [j.jobType].filter(Boolean);
      out.push({
        source: 'jobicy',
        source_id: `jobicy:${j.id}`,
        company: j.companyName || null,
        company_tier: 'watch',
        title: (j.jobTitle || '').trim(),
        url: j.url,
        apply_url: j.url,
        location_raw: geo || 'Remote',
        remote_scope,
        remote_detail: geo,
        employment_type: types.some((t) => /full[- ]?time/i.test(t)) ? 'FullTime'
          : types.some((t) => /part[- ]?time/i.test(t)) ? 'PartTime'
          : types.some((t) => /contract/i.test(t)) ? 'Contract'
          : types.some((t) => /intern/i.test(t)) ? 'Intern' : 'unknown',
        salary_min: j.salaryMin ? Math.round(Number(j.salaryMin)) : null,
        salary_max: j.salaryMax ? Math.round(Number(j.salaryMax)) : null,
        salary_currency: j.salaryCurrency || null,
        salary_period: /year|annual/i.test(j.salaryPeriod || '') ? 'year'
          : /month/i.test(j.salaryPeriod || '') ? 'month'
          : /hour/i.test(j.salaryPeriod || '') ? 'hour' : 'year',
        salary_source: j.salaryMin ? 'structured' : 'unknown',
        posted_at: j.pubDate || null,
        content: stripHtml(j.jobDescription || j.jobExcerpt || '').slice(0, 20000),
        raw: { industry: j.jobIndustry, level: j.jobLevel },
      });
    }
    await sleep(300);
  }
  return out;
}
