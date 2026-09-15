// Ashby public job board API. Free, no key.
//   https://api.ashbyhq.com/posting-api/job-board/<slug>?includeCompensation=true
//
// The best source in this pipeline by a distance. Ashby returns employment type, remote flag,
// per-country secondary locations AND a real structured salary range, so almost nothing has to be
// guessed out of prose. Where a board gives a fact, we take the fact.
import { fetchWithRetry } from '../../sources/_util.mjs';

const API = (slug) => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=true`;

/** Ashby reports salary as an array of components; only the cash one matters for a pay band. */
function cashSalary(compensation) {
  const parts = compensation?.summaryComponents || [];
  const cash = parts.find((c) => c.compensationType === 'Salary' && c.minValue != null);
  if (!cash) return {};
  const period = /1 YEAR/i.test(cash.interval || '') ? 'year'
    : /1 MONTH/i.test(cash.interval || '') ? 'month'
    : /HOUR/i.test(cash.interval || '') ? 'hour' : 'year';
  return {
    salary_min: Math.round(cash.minValue),
    salary_max: Math.round(cash.maxValue ?? cash.minValue),
    salary_currency: cash.currencyCode || 'USD',
    salary_period: period,
    salary_source: 'structured',
  };
}

/** Every place this job can be done, as the board itself lists them. */
function locations(j) {
  const all = [j.location, ...(j.secondaryLocations || []).map((s) => s.location)].filter(Boolean);
  const countries = [...new Set((j.secondaryLocations || [])
    .map((s) => s.address?.postalAddress?.addressCountry).filter(Boolean))];
  return { list: [...new Set(all)], countries };
}

export async function collect(cfg, { slug, company } = {}) {
  const res = await fetchWithRetry(API(slug));
  const { jobs = [] } = await res.json();
  const out = [];

  for (const j of jobs) {
    if (j.isListed === false) continue;
    const { list, countries } = locations(j);

    // A job open in three or more countries, or flagged remote with no country pinned at all, is
    // the shape a genuinely global posting takes. It is a hint, not a verdict - eligibility.mjs
    // still reads the description before believing it.
    const remote_scope = (j.workplaceType === 'Onsite' || j.workplaceType === 'Hybrid') ? 'onsite'
      : j.isRemote && countries.length >= 3 ? 'worldwide'
      : j.isRemote && countries.length ? 'country'
      : j.isRemote ? 'unknown'
      : 'unknown';

    out.push({
      source: 'ashby',
      source_id: `ashby:${slug}:${j.id}`,
      company: company?.name || slug,
      company_tier: company?.tier || 'unknown',
      title: (j.title || '').trim(),
      url: j.jobUrl,
      apply_url: j.applyUrl || j.jobUrl,
      location_raw: list.join(' | '),
      employment_type: j.employmentType || 'unknown',
      remote_scope,
      remote_detail: [j.workplaceType, ...list].filter(Boolean).join(' | '),
      posted_at: j.publishedAt || null,
      content: (j.descriptionPlain || '').slice(0, 20000),
      ...cashSalary(j.compensation),
      raw: { department: j.department, team: j.team, countries, workplaceType: j.workplaceType, isRemote: j.isRemote },
    });
  }
  return out;
}
