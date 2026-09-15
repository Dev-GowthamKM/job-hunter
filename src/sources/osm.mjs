// OpenStreetMap via Overpass. Free, no key, no billing.
// The whole trick: query for businesses that publish a PHONE but have NO website tag. That is a
// literal "this business needs a website" list, worldwide, for nothing.
// Data is ODbL licensed — attribute OpenStreetMap if you ever republish it.
import { fetchWithRetry, sleep } from './_util.mjs';
import { probeForWebsite } from './_probe.mjs';
import { getState, setState } from '../db.mjs';

export const ATTRIBUTION = 'Business data © OpenStreetMap contributors (ODbL)';

/** One query per OSM key, not one big union.
 *  Measured on Bengaluru: a SINGLE clause took 65 seconds on the public mirror, so six of them in
 *  one request could never finish inside any sane timeout. Splitting also means a slow category
 *  degrades into fewer leads instead of losing the whole city. */
function buildQuery(bbox, key, values, limit) {
  const [s, w, n, e] = bbox;
  const box = `${s},${w},${n},${e}`;
  return `[out:json][timeout:90];\n`
       + `nwr["${key}"~"^(${values.join('|')})$"]["phone"~"."]["website"!~"."]`
       + `["contact:website"!~"."]["brand"!~"."]["operator"!~"."](${box});\n`
       + `out center ${limit};`;
}

async function runOverpass(endpoints, query) {
  let lastErr;
  for (const url of endpoints) {
    try {
      const res = await fetchWithRetry(url, {
        method: 'POST',
        tries: 2,
        timeout: 100000,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ data: query }).toString(),
      });
      const txt = await res.text();
      if (!txt.trim().startsWith('{')) throw new Error('Overpass returned an error page (busy)');
      return JSON.parse(txt);
    } catch (err) {
      lastErr = err;
      await sleep(1500);
    }
  }
  throw lastErr;
}

/** Cities rotate one per run, so "worldwide" never means querying the planet at once. */
function nextCity(cities, forced) {
  if (forced) {
    const c = cities.find((x) => x.id === forced || x.name.toLowerCase().includes(forced.toLowerCase()));
    if (!c) throw new Error(`Unknown city "${forced}". Known: ${cities.map((x) => x.id).join(', ')}`);
    return c;
  }
  const i = Number(getState('osm_city_index', '0')) % cities.length;
  setState('osm_city_index', (i + 1) % cities.length);
  return cities[i];
}

export async function collect(cfg, opts = {}) {
  const o = cfg.osm;
  const city = nextCity(o.cities, opts.city);
  const groups = Object.entries(o.businessTypes).filter(([k]) => !k.startsWith('_'));

  const elements = [];
  const failed = [];
  for (const [key, values] of groups) {
    try {
      const data = await runOverpass(o.endpoints, buildQuery(city.bbox, key, values, o.maxPerCity * 2));
      elements.push(...(data.elements || []));
    } catch (err) {
      failed.push(key);                      // one slow category must not lose the whole city
    }
    await sleep(600);                        // be a good citizen on a free public service
  }
  if (!elements.length && failed.length === groups.length) {
    throw new Error(`Overpass unreachable for ${city.name} (all ${failed.length} categories timed out)`);
  }
  if (failed.length) console.log(`      note: ${failed.join(', ')} timed out for ${city.name}, kept the rest`);

  const leads = [];
  for (const el of elements) {
    const t = el.tags || {};
    if (!t.name) continue;
    const phone = t.phone || t['contact:phone'];
    if (!phone) continue;

    const trade = t.amenity || t.shop || t.office || t.craft || t.healthcare || t.leisure || 'business';
    const street = [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ');
    const hasSocialOnly = Boolean(t['contact:facebook'] || t['contact:instagram']);

    leads.push({
      source: 'osm',
      source_id: `osm:${el.type}/${el.id}`,
      title: `${t.name} — ${trade.replace(/_/g, ' ')} in ${city.name}`,
      url: `https://www.openstreetmap.org/${el.type}/${el.id}`,
      company: t.name,
      contact: phone,
      location: [street, t['addr:city'] || city.name].filter(Boolean).join(', '),
      raw: {
        city: city.id, cityName: city.name, tier: city.tier, trade,
        phone,
        email: t.email || t['contact:email'] || null,
        facebook: t['contact:facebook'] || null,
        instagram: t['contact:instagram'] || null,
        openingHours: t.opening_hours || null,
        cuisine: t.cuisine || null,
        suggestedOffer: 'website',
        // A business already running social but with no site is the warmest version of this lead:
        // they have proven they care about being found and still have nowhere to send people.
        relevance: 10 + (hasSocialOnly ? 25 : 0) + (t.email ? 10 : 0) + (t.opening_hours ? 5 : 0),
        attribution: ATTRIBUTION,
      },
    });
  }
  // OSM stores some businesses as BOTH a node and a way. Same shop, two ids, one lead.
  const seen = new Set();
  const unique = leads.filter((l) => {
    const key = `${(l.company || '').toLowerCase()}|${String(l.contact).replace(/\D/g, '')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  unique.sort((a, b) => b.raw.relevance - a.raw.relevance);
  const shortlist = unique.slice(0, o.maxPerCity);

  // A missing website tag means OSM does not KNOW of a website, not that none exists. Verified the
  // hard way: this query returned Wahaca and Breddos, both of which have live sites. Probing the
  // obvious domains here stops an embarrassing "you have no website" pitch reaching a business
  // that plainly does.
  if (opts.skipProbe !== true) {
    const results = await probeForWebsite(shortlist.map((l) => ({ name: l.company, city: city.name })));
    shortlist.forEach((l, i) => {
      const found = results[i];
      l.raw.probedWebsite = found;
      l.raw.verificationRequired = true;
      if (found) l.raw.relevance -= 40;      // still worth a redesign pitch, but it is a different pitch
      l.raw.suggestedOffer = found ? 'website-redesign' : 'website';
    });
    shortlist.sort((a, b) => b.raw.relevance - a.raw.relevance);
  }

  return shortlist;
}
