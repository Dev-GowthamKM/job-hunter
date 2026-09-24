// Workable's cross-company job search. Free, no key.
//   https://jobs.workable.com/api/v1/jobs?query=<phrase>
//
// The most important source in the pipeline, because it is the only one that is QUERY-driven rather
// than company-driven. Every other board adapter can only find jobs at companies already listed in
// config/companies.json, which is why v1 never surfaced a single media-buying role. This one
// searches for what the owner actually does: one search per track title, so coverage follows the
// tracks in config/candidate.json instead of my guess at which employers matter.
//
// Measured: 418 media buyer, 415 facebook ads, 3,315 performance marketing, 2,995 ai engineer.
//
// Those totals are the reason this paginates hard. Taking the first page meant taking 20 of 2,999
// AI-engineer postings and then wondering why the work-from-anywhere filter found nothing: the
// filter was fine, the pool it was given was 0.7% of what existed.
import { getState, setState } from '../../db.mjs';
import { fetchWithRetry, stripHtml, sleep, pool, RateLimited } from '../../sources/_util.mjs';
import { searchQueries } from '../tracks.mjs';

const API = 'https://jobs.workable.com/api/v1/jobs';

/** "TELECOMMUTE" in locations is Workable's remote marker; the rest are real places. */
function geography(j) {
  const places = (j.locations || []).filter((l) => l && l !== 'TELECOMMUTE');
  const telecommute = (j.locations || []).includes('TELECOMMUTE');
  const loc = j.location || {};
  const named = [loc.city, loc.subregion, loc.countryName].filter(Boolean).join(', ');

  // workplace is 'remote' | 'hybrid' | 'on_site'. A remote job still usually names a country, and
  // that country is a restriction - eligibility.mjs reads it from location_raw and decides.
  const scope = j.workplace === 'remote' ? 'unknown' : 'onsite';
  return {
    remote_scope: scope,
    location_raw: [...new Set([named, ...places])].filter(Boolean).join(' | ') || (telecommute ? 'Remote' : ''),
    remote_detail: [j.workplace, ...(j.locations || [])].filter(Boolean).join(' | '),
  };
}

async function search(query, { pages = 1 } = {}) {
  const out = [];
  let token = null;
  for (let p = 0; p < pages; p++) {
    const url = `${API}?query=${encodeURIComponent(query)}${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`;
    let body;
    try {
      body = await fetchWithRetry(url, { timeout: 25000 }).then((r) => r.json());
    } catch (e) {
      // A rate limit is not the end of the results and must not be swallowed.
      //
      // `catch { break }` treated every failure as "no more pages", so when Workable started
      // answering 429 this source returned zero postings and the hunt printed "errors 0". A silent
      // zero from the biggest source in the pipeline is the exact failure this project already
      // warns about: the filter gets blamed for finding nothing when it was never given anything.
      if (e instanceof RateLimited) throw e;
      break;
    }
    out.push(...(body.jobs || []));
    token = body.nextPageToken;
    if (!token) break;
    await sleep(250);                                   // polite: this is one endpoint taking many queries
  }
  return out;
}

const COOLDOWN_KEY = 'workable:blocked-until';
const ROTATE_KEY = 'workable:rotate-from';
// Twelve titles x 4 pages is about 48 requests a run. Empirical: 268 was refused.
const PER_RUN = 12;

export async function collect(cfg, { pages = null } = {}) {
  const cand = cfg?.candidate;
  if (!cand) return [];

  // Do not ask while we are banned.
  //
  // This is what kept Workable down for six days. Every run asked again, every ask returned 429
  // with a fresh 24-hour retry-after, and the ban never got a chance to expire - the system was
  // re-triggering its own block. Three runs in twelve minutes on one morning made 1,608 requests.
  const until = Number(getState(COOLDOWN_KEY, 0));
  if (until && Date.now() < until) {
    const hrs = ((until - Date.now()) / 3600000).toFixed(1);
    throw new Error(`Workable is rate-limiting this IP. Skipping it for another ${hrs}h rather than `
      + `asking again, because asking is what resets the clock. Every other source still runs.`);
  }

  // Rotate the searches instead of running all of them every time.
  //
  // Measured the hard way: 67 titles x 8 pages is 536 requests and got the IP banned for a week.
  // Cutting to 4 pages - 268 requests - was banned again inside one run. Workable's limit is well
  // below that, and no amount of concurrency tuning fixes a volume problem.
  //
  // A daily crawler does not need to re-search every phrase every day. Twelve titles a run is
  // about 48 requests; the offset advances each run, so the full set is covered every six days and
  // anything genuinely new surfaces within that. `--deep` runs all of them at full depth, which is
  // for a deliberate one-off and will probably cost a ban.
  const deep = process.argv.includes('--deep');
  const depth = pages ?? (deep ? 8 : 4);
  const all = searchQueries(cand);

  let queries = all;
  if (!deep && all.length > PER_RUN) {
    const at = Number(getState(ROTATE_KEY, 0)) % all.length;
    queries = Array.from({ length: PER_RUN }, (_, i) => all[(at + i) % all.length]);
    setState(ROTATE_KEY, (at + PER_RUN) % all.length);
    console.log(`  workable      searching ${PER_RUN} of ${all.length} title phrases this run `
      + `(rotating; the full set is covered every ${Math.ceil(all.length / PER_RUN)} runs)`);
  }
  const seen = new Set();
  const out = [];

  // The 67 searches are independent of each other - it is only the PAGES inside one search that
  // must stay in order, because Workable paginates by an opaque pageToken. So the queries run
  // through a pool and each one walks its own cursor.
  // Concurrency 2, not 5.
  //
  // Five got this IP rate-limited by Workable within a single run, and a rate-limited Workable
  // returns nothing at all - which is far worse than a slow one. Two is measurably faster than
  // sequential and stayed under the limit. The number is empirical, not a guess; raise it only
  // with evidence.
  //
  // One 429 stops the whole source: the remaining queries would all be refused anyway, and
  // continuing to ask is what caused the block in the first place.
  let limited = null;
  const perQuery = await pool(queries, 2, async ({ query }) => {
    if (limited) return [];
    try { return await search(query, { pages: depth }); }
    catch (e) { if (e instanceof RateLimited) { limited = e; return []; } throw e; }
  });
  if (limited) {
    // Record when to try again, so the next run skips it instead of resetting the clock. The
    // header is Workable's own number; four hours is a sane floor when they do not send one.
    const wait = Math.max(4 * 3600, Number(limited.retryAfter) || 0) * 1000;
    setState(COOLDOWN_KEY, Date.now() + wait);
    throw new Error(`Workable rate-limited this IP${limited.retryAfter ? `; retry after ${limited.retryAfter}s` : ''}. `
      + `Collected nothing. It will be skipped for ${(wait / 3600000).toFixed(1)}h - asking again is what resets the ban.`);
  }
  // A clean run clears any old cooldown.
  if (getState(COOLDOWN_KEY, 0)) setState(COOLDOWN_KEY, 0);

  for (const [qi, { track, query }] of queries.entries()) {
    const jobs = perQuery[qi] || [];
    for (const j of jobs) {
      if (!j.id || seen.has(j.id)) continue;            // the same job matches several track titles
      seen.add(j.id);

      const geo = geography(j);
      const content = stripHtml([j.description, j.requirementsSection, j.benefitsSection]
        .filter(Boolean).join('\n\n'));

      out.push({
        source: 'workable',
        source_id: `workable:${j.id}`,
        company: j.company?.title || null,
        company_tier: 'watch',                          // not in the curated registry; scored lower
        title: (j.title || '').trim(),
        url: j.url,
        apply_url: j.url,
        employment_type: /full[- ]?time/i.test(j.employmentType || '') ? 'FullTime'
          : /part[- ]?time/i.test(j.employmentType || '') ? 'PartTime'
          : /contract|temporary/i.test(j.employmentType || '') ? 'Contract'
          : /intern/i.test(j.employmentType || '') ? 'Intern' : 'unknown',
        posted_at: j.created || null,
        content: content.slice(0, 20000),
        salary_source: 'unknown',                       // Workable does not expose pay; parsed from text
        track,                                          // which search found it
        ...geo,
        raw: { department: j.department, workplace: j.workplace, foundBy: query, companyUrl: j.company?.url },
      });
    }
  }
  return out;
}
