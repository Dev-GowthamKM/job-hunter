// Keyword coverage between a job description and a tailored resume.
//
// This is a completeness check, not a score to game. It reports which terms the posting leans on
// that the resume never mentions, so the tailorer can close the gaps that are ACTUALLY TRUE of the
// owner. Adding a keyword he cannot back up in an interview is worse than missing it.
import { readFileSync } from 'node:fs';

const STOP = new Set(`a an the and or but if then else for to of in on at by with from as is are was were be been being this that these those you your we our us they their it its will would can could should may might must have has had do does did not no yes all any some more most other into over under about across after before during than through very just also own same so such only team teams work working experience years year role position job company companies candidate candidates applicant looking seeking join build building help helping make making new great strong excellent good best like want need including include includes etc via per within while when where who what which how why here there each both few many much able ability around because between beyond either every however less never often once several since still though unless until upon whether whose without

way ways meet meeting person people world worldwide global globally high low wide range offer offers offering interesting exciting excited amazing opportunity opportunities benefits colleague colleagues member members culture mission values diversity inclusion equal employer employment applicants regardless identity background consideration compensation salary bonus leave holiday annual yearly twice daily weekly monthly time times full part start starting entails expect expects general generally typically often always never really quite pretty lot lots thing things stuff able across almost along already although among another anyone anything appropriate around aside available based basic become becomes begin behind believe below beside besides beyond bring brings broad case cases certain change changes clear come comes common consider considers continue continues day days deep different direct done due early easy end ends enough entire even ever everything example examples far fast find finds first following form forms forward full further future get gets give gives given go goes going great half hand hands happen hard help high hold home hour hours idea ideas immediate important include instead itself keep keeps kind know known large last late later lead least leave left let level levels life like likely line little live long look looking made main major make making manner mark matter maybe mean means meant mid might mind moment month months move much must name near nearly need needs next nice non note nothing now number numbers often old open order others ourselves out outside part particular parts past place places plus point points possible present pretty problem problems process product products provide provides put quite rather reach ready real really reason receive recent report reports require required requires result results right run running said same say says second see seem seen self sense series set sets several share short show side similar simple since single site situation small some someone something sometimes soon sort space special specific stage stand start state stay step steps stop straight strong sub subject support sure system systems take taken taking talk tell term terms test tests think third those though thought three through throughout thus today together told took top total toward towards true try turn two type types under understand unit until upon use used useful using usual value various view want way week weeks well went whatever whenever wherever whole whom whose why wide will wish within without word words world would write written wrong year yet young`.split(/\s+/).filter(Boolean));

// The requirements are the job; the rest is recruiting copy. Weighting a company's "about us"
// paragraph the same as "what we are looking for in you" made a well-tailored resume score 15%,
// with "interesting", "colleagues" and "way" reported as gaps. Terms inside these sections count
// for more.
const REQUIREMENT_HEADINGS = /(what we (?:are )?look(?:ing)? for|requirements?|qualifications?|the role entails|responsibilities|what you.{0,12}ll (?:do|bring)|must have|nice[- ]to[- ]have|skills? (?:and|&) experience|about you|who you are)/i;

const CANON = new Map([
  ['js', 'javascript'], ['ts', 'typescript'], ['reactjs', 'react'], ['react.js', 'react'],
  ['nodejs', 'node'], ['node.js', 'node'], ['postgres', 'postgresql'], ['k8s', 'kubernetes'],
  ['ml', 'machine learning'], ['ai', 'artificial intelligence'], ['llms', 'llm'],
]);

const norm = (w) => CANON.get(w) || w;

function terms(text) {
  const words = (text || '').toLowerCase()
    .replace(/[^a-z0-9+#./\s-]/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^[-.]+|[-.]+$/g, ''))
    .filter((w) => w.length > 2 && w.length < 24 && !STOP.has(w) && !/^\d+$/.test(w))
    .map(norm);
  const freq = new Map();
  for (const w of words) freq.set(w, (freq.get(w) || 0) + 1);
  return freq;
}

/**
 * Terms the posting uses repeatedly are the ones it cares about. Taking the top slice by frequency
 * approximates "what this job is actually about" without needing a model.
 */
export function coverage(jobDescription, resumeText, topN = 30) {
  // Split the posting at its requirement headings and score those parts triple.
  const parts = String(jobDescription || '').split(/\n(?=[^\n]{0,80}$)/m);
  let requirements = '';
  const lines = String(jobDescription || '').split('\n');
  let inReq = false;
  for (const line of lines) {
    if (REQUIREMENT_HEADINGS.test(line)) inReq = true;
    else if (/^\s*(about (the )?(company|us)|what we offer|benefits|equal opportunity|our culture)/i.test(line)) inReq = false;
    if (inReq) requirements += line + '\n';
  }

  const jd = terms(`${jobDescription}\n${requirements}\n${requirements}`);   // requirements count 3x
  const mine = terms(resumeText);
  const wanted = [...jd.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN).map(([w]) => w);
  const hit = wanted.filter((w) => mine.has(w));
  const missing = wanted.filter((w) => !mine.has(w));
  return {
    percent: wanted.length ? Math.round((hit.length / wanted.length) * 100) : 0,
    matched: hit,
    missing,
  };
}

/** Flatten a tailored resume object into the text an ATS would actually see. */
export function resumeText(r) {
  const parts = [
    r.identity?.name, r.identity?.headline, r.summary, r.projectsHeading,
    ...Object.values(r.skills || {}).flat(),
    ...(r.experience || []).flatMap((e) => [e.title, e.company, e.sub, ...(e.bullets || [])]),
    ...(r.projects || []).flatMap((p) => [p.title, p.sub, ...(p.bullets || [])]),
    ...(r.education || []).flatMap((e) => [e.credential, e.institution, e.sub]),
    ...(r.certifications || []).map((c) => `${c.name} ${c.detail || ''}`),
  ];
  return parts.filter(Boolean).join('\n');
}

if (process.argv[1] && process.argv[1].endsWith('ats.mjs')) {
  const [, , resumeJson, jdFile] = process.argv;
  if (!resumeJson || !jdFile) { console.error('usage: node src/jobs/ats.mjs <resume.json> <jd.txt>'); process.exit(1); }
  const r = coverage(readFileSync(jdFile, 'utf8'), resumeText(JSON.parse(readFileSync(resumeJson, 'utf8'))));
  console.log(`coverage ${r.percent}%`);
  console.log(`missing: ${r.missing.join(', ')}`);
}
