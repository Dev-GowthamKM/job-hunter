// Which of the owner's careers does this job belong to?
//
// v1 had one flat list of target titles and a single salary band, which quietly meant "software
// engineer". Every media-buying job he is qualified for was thrown away before it was ever stored.
// A job now resolves to exactly one track first, and the track decides the pay band, the seniority
// rule, which resume facts get selected, and how the dashboard groups it.

/**
 * Exclusions are checked before anything else: they beat a track match, never the other way round.
 *
 * Company-level exclusion exists because title patterns could not keep up with a single employer.
 * Canonical's board is Linux systems engineering top to bottom, and patching titles one at a time
 * ("kernel", then "k8s", then "container images") was losing a race it could not win.
 */
export function isExcluded(title, cand, company = null) {
  const t = (title || '').toLowerCase();
  const c = (company || '').toLowerCase();
  const badCompany = (cand.excludeCompanies || []).find((x) => c.includes(x.toLowerCase()));
  if (badCompany) return `company: ${badCompany}`;
  const hit = (cand.excludeTitles || []).find((x) => t.includes(x.toLowerCase()));
  return hit || null;
}

/**
 * Resolve a job's track.
 *
 * Longest match wins, because the title lists overlap on purpose: "media analyst" must beat
 * "analyst", and "ai engineer" must beat "engineer". Where two tracks match at the same length the
 * order in config decides, which puts the better-paid dev tracks ahead of marketing for a genuinely
 * ambiguous title like "growth engineer".
 */
export function resolveTrack(title, cand) {
  const t = (title || '').toLowerCase();
  if (!t) return null;

  let best = null;
  for (const [key, track] of Object.entries(cand.tracks || {})) {
    if (track.enabled === false) continue;
    for (const phrase of track.titles) {
      const p = phrase.toLowerCase();
      if (!t.includes(p)) continue;
      if (!best || p.length > best.matchLength) {
        best = { track: key, label: track.label, matched: phrase, matchLength: p.length };
      }
    }
  }
  return best;
}

/** The pay band that applies to this job, falling back to the global one when no track resolved. */
export function bandFor(trackKey, cand) {
  const t = cand.tracks?.[trackKey];
  return {
    min: t?.salaryMin ?? cand.compensation.min,
    max: t?.salaryMax ?? cand.compensation.max,
    currency: cand.compensation.currency,
    keepUnknownSalary: cand.compensation.keepUnknownSalary,
    fxToUSD: cand.compensation.fxToUSD,
    entryOnly: !!t?.entryOnly,
  };
}

/** Every search phrase the enabled tracks want, for the query-driven boards. */
export function searchQueries(cand, { perTrack = 0 } = {}) {
  const out = [];
  for (const [key, track] of Object.entries(cand.tracks || {})) {
    if (track.enabled === false) continue;
    const titles = perTrack ? track.titles.slice(0, perTrack) : track.titles;
    for (const q of titles) out.push({ track: key, query: q });
  }
  return out;
}

export function enabledTracks(cand) {
  return Object.entries(cand.tracks || {})
    .filter(([, t]) => t.enabled !== false)
    .map(([key, t]) => ({ key, ...t }));
}
