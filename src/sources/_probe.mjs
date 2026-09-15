// Does this business already have a website that OpenStreetMap simply has not recorded?
// A missing `website` tag is a gap in OSM, not a fact about the business. Without this check the
// pipeline confidently tells established businesses they have no web presence.
import { UA } from './_util.mjs';

const TLDS_BY_CITY = [
  [/london|manchester/i, ['co.uk', 'com', 'uk']],
  [/dublin/i,            ['ie', 'com']],
  [/toronto|vancouver/i, ['ca', 'com']],
  [/sydney|melbourne/i,  ['com.au', 'au', 'com']],
  [/berlin/i,            ['de', 'com']],
  [/amsterdam/i,         ['nl', 'com']],
  [/zurich/i,            ['ch', 'com']],
  [/dubai/i,             ['ae', 'com']],
  [/singapore/i,         ['sg', 'com.sg', 'com']],
  [/bengaluru|mumbai/i,  ['in', 'co.in', 'com']],
];

function slugify(text) {
  return String(text).toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '');
}

/** Business names carry descriptors the domain never does. "Boteco - Restaurante Brasileiro" lives at
 *  boteco.co.in, so probing the full name alone reported no site and wasted a research pass on a
 *  business that plainly had one. Try the trading name as well as the full string. */
function nameCandidates(name) {
  const raw = String(name);
  const out = [raw];
  const head = raw.split(/\s+[-–—|,]\s+|\s+\(/)[0];        // before a dash, comma or bracket
  if (head && head !== raw) out.push(head);
  // "Dali & Gala" lives at daligala.com, not daliandgala.com. An ampersand gets dropped about as
  // often as it gets spelled out, so try both readings.
  if (/&/.test(raw)) out.push(raw.replace(/\s*&\s*/g, ' '), head.replace(/\s*&\s*/g, ' '));
  const firstWord = raw.split(/\s+/)[0];
  if (firstWord && firstWord.length >= 5) out.push(firstWord);
  // "Marzipan Cafe" lives at themarzipan.com. The definite article gets added about as often as
  // it gets dropped, so probe both readings of every candidate built so far.
  for (const v of [...out]) if (!/^the\b/i.test(v)) out.push('the ' + v);
  return [...new Set(out.map(slugify))].filter((s) => s.length >= 4 && s.length <= 30);
}

function candidateDomains(name, city) {
  const tlds = (TLDS_BY_CITY.find(([re]) => re.test(city || ''))?.[1]) || ['com'];
  const slugs = nameCandidates(name);
  const domains = [];
  // TLD-major order: try EVERY name variant on the first TLD before moving to the second. Slug-major
  // order put all four "marzipancafe.*" guesses ahead of "themarzipan.com", and the per-lead cap
  // then cut the list before reaching the domain that actually exists.
  for (const t of tlds.slice(0, 3)) {
    for (const slug of slugs) domains.push(`${slug}.${t}`);
  }
  return domains.slice(0, 12);                               // bounded: this runs per lead
}

/** Registrable domain, roughly: the last two labels, or three for co.uk / co.in style suffixes. */
function registrable(host) {
  const parts = String(host).toLowerCase().replace(/^www\./, '').split('.');
  const multi = /^(co|com|org|net|gov|ac)\.[a-z]{2}$/.test(parts.slice(-2).join('.'));
  return parts.slice(multi ? -3 : -2).join('.');
}

/** A domain that redirects to a DIFFERENT registrable domain is a squat or a parking redirect, not
 *  this business's site. Verified: standings.com resolves 200 but serves markcubancompanies.com. */
function sameSite(finalUrl, candidate) {
  try { return registrable(new URL(finalUrl).hostname) === registrable(candidate); }
  catch { return false; }
}

async function alive(domain) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 6000);
  try {
    const res = await fetch(`https://${domain}`, {
      method: 'GET', redirect: 'follow', signal: ctl.signal, headers: { 'User-Agent': UA },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const html = (await res.text()).slice(0, 4000).toLowerCase();
    // Parked and for-sale pages resolve 200 and are not a real web presence.
    const PARKED = /domain (is |name )?(is )?for sale|parked (domain|free|for free)|buy this domain|godaddy\.com\/domainsearch|this (web ?)?page is parked|domain may be for sale|related searches|inquire about this domain/;
    if (PARKED.test(html)) return null;
    const finalUrl = res.url || `https://${domain}`;
    if (!sameSite(finalUrl, domain)) return null;
    return finalUrl;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

/** Probe many businesses with bounded concurrency. Returns a found-URL (or null) per input, in order. */
export async function probeForWebsite(items, concurrency = 6) {
  const out = new Array(items.length).fill(null);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const i = cursor++;
      for (const d of candidateDomains(items[i].name, items[i].city)) {
        const hit = await alive(d);
        if (hit) { out[i] = hit; break; }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return out;
}
