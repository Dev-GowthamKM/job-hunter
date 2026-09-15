// Himalayas remote job feed. Free, no key.
//   https://himalayas.app/jobs/api
//
// The best eligibility data of any source in this pipeline. Every other board makes you infer where
// a job is open from prose; Himalayas states it as an array of countries in `locationRestrictions`.
// An EMPTY array means no restriction at all, which is precisely the work-from-anywhere signal this
// whole filter exists to find, and it needs no guessing.
import { fetchWithRetry, stripHtml, sleep } from '../../sources/_util.mjs';

const API = 'https://himalayas.app/jobs/api';

export async function collect(cfg, { pages = 40 } = {}) {
  const out = [];
  let cursor = null, lastCursor = null;

  for (let p = 0; p < pages; p++) {
    // The API caps a page at 20 whatever `limit` says, so depth comes from the cursor, not the size.
    const url = `${API}?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    let body;
    try { body = await fetchWithRetry(url, { timeout: 30000 }).then((r) => r.json()); }
    catch { break; }

    const jobs = body.jobs || body.data || [];
    if (!jobs.length) break;

    for (const j of jobs) {
      const restrictions = j.locationRestrictions || [];
      const tz = j.timezoneRestrictions || [];

      // Stated as data, so believed as data.
      const remote_scope = restrictions.length === 0 ? 'worldwide'
        : restrictions.some((r) => /india/i.test(r)) ? 'region'
        : 'country';

      out.push({
        source: 'himalayas',
        source_id: `himalayas:${j.guid || j.applicationLink || j.title}`,
        company: j.companyName || null,
        company_tier: 'watch',
        title: (j.title || '').trim(),
        url: j.applicationLink || (j.companySlug ? `https://himalayas.app/companies/${j.companySlug}` : null),
        apply_url: j.applicationLink || null,
        location_raw: restrictions.length ? restrictions.join(', ') : 'Worldwide',
        remote_scope,
        remote_detail: [restrictions.join(', '), tz.length ? `timezones: ${tz.join(', ')}` : ''].filter(Boolean).join(' | ') || 'Worldwide',
        employment_type: /full[- ]?time/i.test(j.employmentType || '') ? 'FullTime'
          : /part[- ]?time/i.test(j.employmentType || '') ? 'PartTime'
          : /contract/i.test(j.employmentType || '') ? 'Contract'
          : /intern/i.test(j.employmentType || '') ? 'Intern' : 'unknown',
        salary_min: j.minSalary ?? null,
        salary_max: j.maxSalary ?? null,
        salary_currency: j.currency || (j.minSalary ? 'USD' : null),
        salary_period: /year|annual/i.test(j.salaryPeriod || 'year') ? 'year' : (j.salaryPeriod || 'year'),
        salary_source: j.minSalary ? 'structured' : 'unknown',
        posted_at: j.pubDate || null,
        content: stripHtml(j.description || j.excerpt || '').slice(0, 20000),
        raw: { seniority: j.seniority, categories: j.categories, restrictions, timezoneRestrictions: tz },
      });
    }

    cursor = body.nextCursor || body.cursor || null;
    if (cursor && String(cursor) === String(lastCursor)) break;      // defensive: never loop forever
    lastCursor = cursor;
    if (!cursor) break;
    await sleep(300);
  }
  return out;
}
