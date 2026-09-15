// Layer 1 of the eligibility filter: deterministic, free, runs on every job before any LLM sees it.
//
// The design rule here is that EVERY verdict carries the sentence that caused it. A filter that
// silently drops 900 jobs is indistinguishable from a broken scraper, so `--near-miss` must be able
// to show the owner the exact words that killed each one. If a reason ever reads as a bare rule
// name with no quote, that is a bug.
//
// Layer 2 (an agent reading the full JD) only ever sees what survives this file.
import { resolveTrack, isExcluded, bandFor } from './tracks.mjs';

/** Cut a readable quote around a regex hit, so the reason names real words from the posting. */
function evidence(text, match, span = 55) {
  if (!match || match.index == null) return null;
  const start = Math.max(0, match.index - span);
  const end = Math.min(text.length, match.index + match[0].length + span);
  return (start ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ').trim() + (end < text.length ? '…' : '');
}

const find = (text, re) => { const m = re.exec(text); return m ? { m, quote: evidence(text, m) } : null; };
const firstHit = (text, patterns) => {
  for (const { re, label } of patterns) { const hit = find(text, re); if (hit) return { ...hit, label }; }
  return null;
};

// ---------------------------------------------------------------------------
// Geography
// ---------------------------------------------------------------------------

// Anchored deliberately. Bare /hybrid/ matches "hybrid cloud architecture" and bare /on-?site/
// matches "on-site support tooling" - both would reject good jobs for no reason.
const GEO_REJECT = [
  { label: 'us-work-authorization', re: /\b(?:must be |currently )?(?:legally )?authorized to work in the (?:US|U\.S\.|United States)\b/i },
  { label: 'us-work-authorization', re: /\bwork authorization in the (?:US|United States)\b/i },
  { label: 'us-citizen', re: /\b(?:US|U\.S\.) (?:citizen|person)(?:ship)?\s+(?:is\s+)?(?:require|status)/i },
  { label: 'security-clearance', re: /\b(?:security|government) clearance\b/i },
  { label: 'no-sponsorship', re: /\b(?:visa )?sponsorship (?:is )?(?:not|unavailable|cannot)\b|\bwe (?:do not|don't|cannot) sponsor\b|\bunable to sponsor\b/i },
  { label: 'us-only-remote', re: /\bremote\s*[-(–—,]\s*(?:US|USA|U\.S\.|United States)\b(?!\s*(?:,|\/|\bor\b|\band\b))/i },
  { label: 'us-based-only', re: /\b(?:must be |candidates? must be )?(?:US|U\.S\.|United States)[- ]based\b/i },
  { label: 'must-reside', re: /\bmust (?:reside|be located|live) in\b/i },
  { label: 'region-locked', re: /\b(?:EU|EMEA|LATAM|APAC|UK|Canada|Europe)[- ]only\b/i },
  { label: 'region-locked', re: /\beligible to work in (?:the )?(?:EU|UK|European Union|Canada|Australia)\b/i },
  { label: 'hybrid-schedule', re: /\bhybrid (?:role|position|work(?:ing)? (?:model|arrangement|schedule)|schedule|setup)\b/i },
  { label: 'days-in-office', re: /\b\d\s*(?:\+\s*)?days? (?:a|per) week in (?:the )?office\b|\bin[- ]office \d\s*days?\b/i },
  { label: 'onsite-role', re: /\bthis (?:is|role is) (?:an? )?(?:on-?site|in-?person|office-based)\b/i },
  { label: 'must-relocate', re: /\b(?:must|willing to|required to) relocate\b/i },
];

// Phrases that only mean something when they appear in a LOCATION field. A job description saying
// "we serve customers worldwide" or "we are a globally distributed team" tells you nothing about
// where you are allowed to live - that is marketing copy, and treating it as an eligibility signal
// was letting UK-only and US-only roles through as "worldwide".
const LOC_GLOBAL = /\b(?:worldwide|anywhere|global(?:ly)?)\b/i;

// Phrases strong enough to trust in body prose, because they are statements about hiring, not
// about the company's customers or its self-image.
const BODY_ACCEPT = [
  // The negative lookahead matters: "work from anywhere within this region" and
  // "work from anywhere in the US" are restrictions, and reading them as permissions put
  // North-America-only roles into the eligible pile.
  { label: 'work-from-anywhere', re: /\bwork from anywhere\b(?!\s*(?:with)?in\b|\s+in the (?:US|United States|EU|UK|country|region)\b|:)/i },
  { label: 'live-anywhere', re: /\b(?:live|be based|be located) anywhere\b(?!\s*(?:with)?in\b)/i },
  { label: 'hires-globally', re: /\bwe hire (?:globally|worldwide|from anywhere|in any country)\b/i },
  { label: 'hires-globally', re: /\bhiring (?:globally|worldwide|across the globe)\b/i },
  { label: 'hires-globally', re: /\bhir(?:e|ing) (?:people |engineers )?(?:from )?anywhere in the world\b/i },
  { label: 'no-location-requirement', re: /\bno location requirement\b|\bregardless of where you (?:live|are based)\b/i },
  { label: 'any-country', re: /\bfrom any country\b|\bin any time ?zone\b/i },
];

// Region tokens that appear in location fields. Finding these WITHOUT a global token means the
// role is pinned to somewhere the owner does not live.
// A hand-written region list was always going to be wrong: it knew "Canada" and "Poland" but not
// Armenia, Serbia or Georgia, so 21 junior media-buying roles pinned to those countries fell through
// as "location unstated" and were never judged. Naming every country is the only version of this
// that is actually correct.
const COUNTRIES = `Afghanistan|Albania|Algeria|Andorra|Angola|Argentina|Armenia|Australia|Austria|Azerbaijan|Bahamas|Bahrain|Bangladesh|Barbados|Belarus|Belgium|Belize|Benin|Bhutan|Bolivia|Bosnia|Botswana|Brazil|Brunei|Bulgaria|Burkina Faso|Burundi|Cambodia|Cameroon|Canada|Chad|Chile|China|Colombia|Congo|Costa Rica|Croatia|Cuba|Cyprus|Czechia|Czech Republic|Denmark|Dominican Republic|Ecuador|Egypt|El Salvador|Estonia|Eswatini|Ethiopia|Fiji|Finland|France|Gabon|Gambia|Georgia|Germany|Ghana|Greece|Guatemala|Guinea|Guyana|Haiti|Honduras|Hong Kong|Hungary|Iceland|Indonesia|Iran|Iraq|Ireland|Israel|Italy|Ivory Coast|Jamaica|Japan|Jordan|Kazakhstan|Kenya|Kosovo|Kuwait|Kyrgyzstan|Laos|Latvia|Lebanon|Liberia|Libya|Liechtenstein|Lithuania|Luxembourg|Macau|Madagascar|Malawi|Malaysia|Maldives|Mali|Malta|Mauritania|Mauritius|Mexico|Moldova|Monaco|Mongolia|Montenegro|Morocco|Mozambique|Myanmar|Namibia|Nepal|Netherlands|New Zealand|Nicaragua|Niger|Nigeria|North Macedonia|Norway|Oman|Pakistan|Palestine|Panama|Papua New Guinea|Paraguay|Peru|Philippines|Poland|Portugal|Qatar|Romania|Russia|Rwanda|Saudi Arabia|Senegal|Serbia|Seychelles|Sierra Leone|Singapore|Slovakia|Slovenia|Somalia|South Africa|South Korea|Korea|South Sudan|Spain|Sri Lanka|Sudan|Suriname|Sweden|Switzerland|Syria|Taiwan|Tajikistan|Tanzania|Thailand|Togo|Trinidad|Tunisia|Turkey|T\u00fcrkiye|Turkmenistan|Uganda|Ukraine|United Arab Emirates|UAE|United Kingdom|United States|Uruguay|Uzbekistan|Venezuela|Vietnam|Yemen|Zambia|Zimbabwe`;

const REGION_TOKENS = new RegExp(`\\b(?:EMEA|AMER|NAMER|Americas|North America|South America|Latin America|LATAM|Europe|European|EU|Nordics|DACH|Benelux|Middle East|Africa|Oceania|APAC|USA|U\\.S\\.|US|UK|${COUNTRIES})\\b`, 'gi');

const INDIA_TOKENS = /\b(?:India|APAC|Asia[- ]Pacific|Bangalore|Bengaluru|Mumbai|Hyderabad|Delhi|Pune|Chennai|IST)\b/i;
const ONSITE_TOKENS = /\b(?:hybrid|on-?site|in-?office|in[- ]person)\b/i;

const INDIA_ACCEPT = [
  { label: 'india-named', re: /\b(?:remote,? )?india\b/i },
  { label: 'apac-named', re: /\bAPAC\b|\bAsia[- ]Pacific\b/i },
  { label: 'ist-overlap', re: /\bIST\b|\bIndian Standard Time\b/i },
];

/**
 * Decide how wide a job's geography is.
 *
 * Two sources of truth, weighted deliberately:
 *   - The location / workplace fields, which boards fill in structurally. Trusted.
 *   - The description body, where only explicit hiring statements count. Everything else is noise.
 *
 * A restriction always beats a permission. "Fully distributed team!" next to "Remote (US)" is a
 * US job, and reading it the other way round is precisely how this pipeline wastes the owner's time.
 */
export function classifyRemote(job) {
  const loc = [job.location_raw, job.remote_detail].filter(Boolean).join(' | ').trim();
  const body = `${job.title || ''}\n${job.content || ''}`;

  // 1. A hard restriction anywhere wins outright.
  const reject = firstHit(`${loc}\n${body}`, GEO_REJECT);
  if (reject) {
    const scope = /hybrid|onsite|days-in-office|relocate/.test(reject.label) ? 'onsite' : 'country';
    return { scope, label: reject.label, quote: reject.quote };
  }

  // "Remote - Anywhere" is generic AND global, and the global half is the answer. Checking generic
  // first swallowed it and sent a genuinely worldwide role off to be guessed at from body prose.
  if (loc && LOC_GLOBAL.test(loc)) {
    return { scope: 'worldwide', label: 'location-field-global', quote: loc.slice(0, 140) };
  }
  // A location field that only says "Remote" carries no geography; anything else does.
  const genericLoc = !loc || /^(?:\s*(?:remote|flexible|n\/?a|home based|distributed)\s*[|,\/-]?\s*)+$/i.test(loc);

  // 2. The location field, read as data. When it names a place, it is the answer - a perks section
  //    saying "work from anywhere" cannot widen a role the board already pinned to a region.
  if (!genericLoc) {
    if (ONSITE_TOKENS.test(loc) && !LOC_GLOBAL.test(loc)) {
      return { scope: 'onsite', label: 'location-field-onsite', quote: loc.slice(0, 140) };
    }
    if (INDIA_TOKENS.test(loc)) return { scope: 'region', label: 'location-includes-india', quote: loc.slice(0, 140) };

    // Anything else specific in a location field IS a restriction.
    //
    // Matching against a list of place names does not work and cannot be made to work: a country
    // list missed Toronto and Tokyo, a city list would miss the next thousand. A location field
    // exists to say where the job is — so if it says anything that is not a generic remote word, it
    // is naming somewhere, and somewhere is not everywhere.
    const regions = [...new Set((loc.match(REGION_TOKENS) || []).map((r) => r.toUpperCase()))];
    return {
      scope: 'country',
      label: regions.length ? 'location-field-restricted' : 'location-names-a-place',
      quote: loc.slice(0, 140),
    };
  }

  // 3. Only now - with no location on the posting at all - explicit hiring statements in the body.
  const accept = firstHit(body, BODY_ACCEPT);
  if (accept) return { scope: 'worldwide', label: accept.label, quote: accept.quote };

  const india = firstHit(body, INDIA_ACCEPT);
  if (india) return { scope: 'region', label: india.label, quote: india.quote };

  if (job.remote_scope && !['unknown', 'worldwide'].includes(job.remote_scope)) {
    return { scope: job.remote_scope, label: 'board-field', quote: job.remote_detail };
  }
  return { scope: 'unknown', label: 'nothing-stated', quote: null };
}

// ---------------------------------------------------------------------------
// Salary
// ---------------------------------------------------------------------------

const CURRENCY = { '$': 'USD', 'US$': 'USD', '£': 'GBP', '€': 'EUR', '₹': 'INR', 'usd': 'USD', 'eur': 'EUR', 'gbp': 'GBP', 'inr': 'INR', 'cad': 'CAD' };
const num = (s) => Number(String(s).replace(/[,\s]/g, ''));

/** "$120k", "$120,000", "120K" -> 120000 */
function money(raw) {
  const t = String(raw).trim().toLowerCase();
  const k = /k$/.test(t);
  const n = num(t.replace(/k$/, ''));
  if (!Number.isFinite(n)) return null;
  return k ? n * 1000 : n;
}

/**
 * Pull a pay range out of prose.
 *
 * Taking the first money range in a job description does not work: postings list equity grants,
 * signing bonuses, wellness stipends and 401k matches, often before base pay. Reading
 * "New hire equity: $16,000-$24,000" as a salary is what made a $190k Affirm role look like a
 * $24k one. So every candidate range is scored by the words immediately before it, and base pay
 * wins. When nothing looks like base pay, we return nothing rather than guess.
 */
const BASE_PAY_CUE = /(?:base (?:pay|salary|compensation)|salary range|pay range|compensation range|annual salary|base range|salary band|expected (?:salary|compensation)|cash compensation|(?:USD|GBP|EUR|INR|CAD|SGD|ESP|GBR)\s+base pay range)[^.\n]{0,60}$/i;
const NOT_PAY_CUE = /(?:equity|stock|option|RSU|bonus|stipend|reimburse|401\(?k\)?|match|allowance|budget|discount|donation|revenue|funding|raised|valuation|ARR|customers?|users?)[^.\n]{0,40}$/i;
const TRAILING_NOT_PAY = /^[^.\n]{0,25}\b(?:equity|stock|RSU|bonus|stipend|allowance|reimbursement|budget|grant|credits?)\b/i;

export function parseSalary(text = '') {
  if (!text) return null;

  const RANGE = /([$£€₹]|USD|EUR|GBP|INR|CAD|SGD|AUD)\s?([\d][\d,]*(?:\.\d+)?k?)\s*(?:-|–|—|to|up to)\s*([$£€₹]|USD|EUR|GBP|INR|CAD|SGD|AUD)?\s?([\d][\d,]*(?:\.\d+)?k?)/gi;
  const candidates = [];

  for (const m of text.matchAll(RANGE)) {
    const lo = money(m[2]), hi = money(m[4]);
    if (!lo || !hi || hi < lo) continue;
    const before = text.slice(Math.max(0, m.index - 90), m.index);
    // The disqualifying word can land on either side: "equity: $16k-$24k" puts it before,
    // "$1,000-$2,000 wellness stipend" puts it after.
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 40);
    if (NOT_PAY_CUE.test(before) || TRAILING_NOT_PAY.test(after)) continue;
    candidates.push({
      min: lo, max: hi,
      currency: CURRENCY[m[1]] || CURRENCY[String(m[1]).toLowerCase()] || m[1].toUpperCase(),
      period: inferPeriod(text, m.index),
      source: 'parsed',
      isBase: BASE_PAY_CUE.test(before),
      quote: evidence(text, m),
    });
  }

  // Europe writes the currency after the number: "57,000 - 87,000 EUR".
  const TRAILING_CUR = /([\d][\d,]{3,}(?:\.\d+)?|[\d]{2,3}k)\s*(?:-|–|—|to)\s*([\d][\d,]{3,}(?:\.\d+)?|[\d]{2,3}k)\s*(USD|EUR|GBP|INR|CAD|SGD|AUD)\b/gi;
  for (const m of text.matchAll(TRAILING_CUR)) {
    const lo = money(m[1]), hi = money(m[2]);
    if (!lo || !hi || hi < lo) continue;
    const before = text.slice(Math.max(0, m.index - 90), m.index);
    if (NOT_PAY_CUE.test(before)) continue;
    candidates.push({
      min: lo, max: hi, currency: m[3].toUpperCase(), period: inferPeriod(text, m.index),
      source: 'parsed', isBase: BASE_PAY_CUE.test(before), quote: evidence(text, m),
    });
  }

  // An explicitly labelled base-pay range beats an unlabelled one, always.
  const best = candidates.find((c) => c.isBase) || candidates[0];
  if (best) { const { isBase, ...rest } = best; return rest; }

  // Hourly rates are two digits, so they need their own pattern - the general one below demands
  // four digits to avoid matching "$50 gift card" and similar noise in a benefits section.
  const HOURLY = /([$£€₹])\s?(\d{2,3}(?:\.\d+)?)\s*(?:\/|per\s)\s?(?:hr|hour)\b/i;
  const h = HOURLY.exec(text);
  if (h) {
    const before = text.slice(Math.max(0, h.index - 90), h.index);
    const v = money(h[2]);
    if (v && !NOT_PAY_CUE.test(before)) return { min: v, max: v, currency: CURRENCY[h[1]] || 'USD', period: 'hour', source: 'parsed', quote: evidence(text, h) };
  }

  const SINGLE = /([$£€₹]|USD|EUR|GBP|INR)\s?([\d][\d,]{3,}(?:\.\d+)?|[\d]{2,3}k)\b/i;
  const single = SINGLE.exec(text);
  if (single) {
    const before = text.slice(Math.max(0, single.index - 90), single.index);
    const v = money(single[2]);
    if (v && v >= 1000 && BASE_PAY_CUE.test(before)) {
      return { min: v, max: v, currency: CURRENCY[single[1]] || CURRENCY[single[1].toLowerCase()] || 'USD', period: inferPeriod(text, single.index), source: 'parsed', quote: evidence(text, single) };
    }
  }
  return null;
}

function inferPeriod(text, at) {
  const window = text.slice(Math.max(0, at - 60), at + 160).toLowerCase();
  if (/per hour|\/\s?hr|\/\s?hour|hourly/.test(window)) return 'hour';
  if (/per month|\/\s?mo\b|monthly/.test(window)) return 'month';
  return 'year';
}

/** Everything is compared as annual. 2080 = 40h x 52w, the standard full-time year. */
export function toAnnual(amount, period) {
  if (amount == null) return null;
  if (period === 'hour') return Math.round(amount * 2080);
  if (period === 'month') return Math.round(amount * 12);
  return Math.round(amount);
}

// ---------------------------------------------------------------------------
// Seniority
// ---------------------------------------------------------------------------

export function seniorityVerdict(job, cand) {
  const title = (job.title || '').toLowerCase();
  const sen = cand.seniority;

  for (const p of sen.rejectTitlePatterns) {
    const re = new RegExp(p, 'i');
    if (re.test(title)) return { ok: false, reason: `title is too senior ("${job.title}")` };
  }
  const years = /(\d+)\s*\+?\s*(?:-\s*\d+\s*)?years?(?:'| of)? (?:of )?(?:professional |relevant |industry |software )?experience/i.exec(job.content || '');
  if (years) {
    const n = Number(years[1]);
    if (n > sen.rejectYearsAbove) {
      return { ok: false, reason: `wants ${n}+ years, you have ~${sen.yearsExperience}`, quote: evidence(job.content, years) };
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * Cheap pre-gate: is this job in ANY of the owner's careers?
 *
 * hunt.mjs uses this to decide what is worth STORING. A board returns thousands of roles that are
 * nothing to do with him, and keeping their rejections would bury the near-miss report in noise
 * that was never a near miss.
 *
 * v1 got this badly wrong: one flat list of software titles meant every media-buying job he is
 * qualified for was discarded before it was ever written down. Returns the resolved track so the
 * caller can store it, or null.
 */
export function roleRelevant(job, cand) {
  const title = job.title || '';
  if (!title) return null;
  if (isExcluded(title, cand, job.company)) return null;
  return resolveTrack(title, cand);
}

/**
 * Layer 1 verdict for one job.
 * Returns { eligibility: 'yes'|'no'|'unclear', reason, layer:'rules', status, salary }.
 * 'unclear' means a human or an agent has to read it - under global-only mode the caller turns
 * that into a rejection, but the reason is preserved either way so --near-miss stays honest.
 */
/**
 * Why a job is worth showing, and how strongly.
 *
 *   match     work-from-anywhere, right level, pay in band. Apply to these.
 *   stretch   work-from-anywhere but above his level, or the pay is unknown or outside the band.
 *             Reachable in principle; his call.
 *   regional  right role, wrong geography — tied to a country he is not in.
 *   no        not one of his roles, not full-time, or a dealbreaker.
 *
 * A binary eligible/rejected was hiding 2,167 seniority-rejected jobs and 984 geographic ones behind
 * a "near misses" page nobody had a reason to open. The tier is the same judgement, kept in front of
 * him and sortable, instead of a verdict that deletes things quietly.
 */
export function tierOf(verdict) {
  if (verdict.eligibility === 'yes') return 'match';
  const r = verdict.reason || '';
  if (/geographically restricted|restricted to a region|open to India|not remote/i.test(r)) return 'regional';
  if (/too senior|wants \d+\+ years|misses your .* band|no salary published|entry-level only/i.test(r)) {
    // Only a stretch if he could actually be there - a country-locked senior role is still regional.
    return verdict.geoScope === 'worldwide' ? 'stretch' : 'regional';
  }
  if (/never states a location/i.test(r)) return 'stretch';
  return 'no';
}

export function screen(job, cand, track = null) {
  const text = `${job.title || ''}\n${job.content || ''}`;
  const resolved = track || resolveTrack(job.title, cand);
  const trackKey = resolved?.track ?? null;
  const no = (reason, extra = {}) => ({ eligibility: 'no', reason, layer: 'rules', status: 'rejected', track: trackKey, geoScope: geoEarlyScope(), ...extra });
  const yes = (reason, extra = {}) => ({ eligibility: 'yes', reason, layer: 'rules', status: 'screened', track: trackKey, geoScope: geoEarlyScope(), ...extra });
  const maybe = (reason, extra = {}) => ({ eligibility: 'unclear', reason, layer: 'rules', status: 'screened', track: trackKey, geoScope: geoEarlyScope(), ...extra });

  let _geo = null;
  const geoEarlyScope = () => (_geo ||= classifyRemote(job)).scope;

  const excluded = isExcluded(job.title, cand, job.company);
  if (excluded) {
    return no(excluded.startsWith('company: ')
      ? `you excluded this employer — ${excluded.slice(9)}`
      : `not a kind of job you want — title contains "${excluded}"`);
  }

  // 1. Dealbreakers -------------------------------------------------------
  for (const d of cand.dealbreakers) {
    const hit = find(text, new RegExp(`\\b${d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'));
    if (hit) return no(`dealbreaker "${d}" — ${hit.quote}`);
  }

  // 2. Employment type ----------------------------------------------------
  const et = job.employment_type || 'unknown';
  if (et !== 'unknown' && !cand.employment.types.includes(et)) {
    return no(`employment type is ${et}, not full-time`);
  }
  if (et === 'unknown') {
    const bad = firstHit(text, [
      // "Contract of Employment" / "permanent contract" is European employment-law boilerplate for a
      // STAFF job. Reading it as contractor work rejected perfectly good full-time roles.
      { label: 'contract', re: /\b(?:contract-to-hire|c2c)\b|\bcontractor\b|\bcontract\b(?!\s+(?:of employment|type)\b)(?<!\bemployment\s)(?<!\bpermanent\s)/i },
      { label: 'part-time', re: /\bpart[- ]time\b/i },
      { label: 'internship', re: /\bintern(?:ship)?\b/i },
      { label: 'freelance', re: /\bfreelance\b/i },
      { label: 'temporary', re: /\btemporary\b|\bfixed[- ]term\b/i },
    ]);
    if (bad) return no(`looks like ${bad.label} work — ${bad.quote}`);
  }

  // 3. Role shape ---------------------------------------------------------
  if (!trackKey) return no(`title does not match any of your tracks ("${job.title}")`);

  // Geography is computed up front now, because the tier depends on it even for a rejection: a
  // Principal role open worldwide is a stretch, the same role pinned to Toronto is not.
  // 4. Seniority ----------------------------------------------------------
  const band = bandFor(trackKey, cand);
  const sen = seniorityVerdict(job, cand);
  if (!sen.ok) return no(sen.reason, { quote: sen.quote });
  if (band.entryOnly && !/\b(junior|graduate|entry|associate|intern-to|trainee|apprentice|\bi\b)\b/i.test(job.title || '')) {
    return no(`${trackKey} is set to entry-level only and this title is not ("${job.title}")`);
  }

  // 5. Salary -------------------------------------------------------------
  const structured = job.salary_min ? {
    min: job.salary_min, max: job.salary_max || job.salary_min,
    currency: job.salary_currency || 'USD', period: job.salary_period || 'year', source: 'structured',
  } : null;
  const salary = structured || parseSalary(job.content || '');

  if (salary) {
    const fx = band.fxToUSD || {};
    const rate = salary.currency === band.currency ? 1 : fx[salary.currency];
    if (!rate) {
      return maybe(`pay is in ${salary.currency} and no FX rate is configured — add one to config/candidate.json`, { salary });
    }
    const lo = Math.round(toAnnual(salary.min, salary.period) * rate);
    const hi = Math.round(toAnnual(salary.max, salary.period) * rate);
    const conv = rate === 1 ? '' : ` (${salary.currency} at ${rate}, as of ${fx.asOf})`;
    const overlaps = hi >= band.min && lo <= band.max;
    if (!overlaps) {
      return no(`pay ${fmt(lo)}–${fmt(hi)}${conv} misses your ${fmt(band.min)}–${fmt(band.max)} band`, { salary });
    }
    salary.usdMin = lo; salary.usdMax = hi;
  } else if (!band.keepUnknownSalary) {
    return no('no salary published');
  }

  // 6. Geography — the one that actually decides most of these ------------
  const geo = (_geo ||= classifyRemote(job));
  if (geo.scope === 'onsite') return no(`not remote — ${geo.quote || geo.label}`, { salary });
  if (geo.scope === 'country' || geo.scope === 'region') {
    const detail = geo.quote || geo.label;
    const openToIndia = geo.label === 'location-includes-india' || firstHit(`${job.location_raw || ''} ${job.remote_detail || ''}`, INDIA_ACCEPT);

    // A role open to India is one the owner can legally and practically take, since that is where
    // they live. Rejecting it as "geographically restricted" would be technically consistent with
    // work-from-anywhere and completely useless in practice. Under global-only it is not promoted
    // to a match - the owner asked for location freedom - but it is surfaced, never buried.
    if (openToIndia) {
      if (cand.eligibility.mode === 'global-only') {
        return maybe(`open to India, but tied to it — not work-from-anywhere — ${detail}`, { salary, bucket: 'india' });
      }
      return yes(`open to India — ${detail}`, { salary, bucket: 'india' });
    }
    return no(`geographically restricted — ${detail}`, { salary });
  }
  if (geo.scope === 'worldwide') {
    return yes(`worldwide — ${geo.quote || geo.label}`, { salary });
  }

  // Nothing said either way. This is the big bucket, and it is what layer 2 exists for.
  return maybe('posting never states a location requirement — needs the JD read in full', { salary });
}

const fmt = (n) => (n == null ? '?' : n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${n}`);
export { fmt, evidence };
