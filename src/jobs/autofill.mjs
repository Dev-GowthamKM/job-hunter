// Filling in an application form, without ever submitting one.
//
// A server cannot reach into the owner's browser, and it should not: the form lives on someone
// else's site, behind his session. So this produces two things instead —
//
//   1. An answer sheet: every field and every likely screening question, already answered from the
//      fact bank and the research dossier, ready to copy.
//   2. A bookmarklet. He opens the application page, clicks it, and it fills every field it can
//      match, highlights what it touched, and STOPS. It contains no click on a submit control and
//      never will; adding one would move the decision out of his hands, which is the one thing this
//      whole system is built not to do.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, db } from '../db.mjs';

/** The standard fields every ATS asks for, taken from the profile rather than typed again. */
export function profileFields() {
  const master = JSON.parse(readFileSync(join(ROOT, 'data', 'resume', 'master.json'), 'utf8'));
  const cand = JSON.parse(readFileSync(join(ROOT, 'config', 'candidate.json'), 'utf8'));
  const id = { ...master.identity, ...cand.identity };
  const [first, ...rest] = String(id.name || '').split(' ');

  return {
    firstName: first || '',
    lastName: rest.join(' ') || '',
    fullName: id.name || '',
    email: id.email || '',
    phone: id.phone || '',
    location: id.basedIn || id.location || '',
    // Derived from config, never hardcoded: the source file is public, the config is not.
    city: String(id.basedIn || id.location || '').split(',')[0].trim(),
    country: String(id.basedIn || id.location || '').split(',').pop().trim(),
    linkedin: id.linkedin ? `https://www.linkedin.com/in/${String(id.linkedin).replace(/\s+/g, '')}` : '',
    website: '',
    github: '',
  };
}

/**
 * Answers to the questions ATS forms actually ask.
 *
 * Every one is drawn from what the fact bank can support. Where the honest answer is "no", it says
 * no — an application that claims work authorization he does not have fails at the first check and
 * burns the company.
 */
export function screeningAnswers(job) {
  const master = JSON.parse(readFileSync(join(ROOT, 'data', 'resume', 'master.json'), 'utf8'));
  const cand = JSON.parse(readFileSync(join(ROOT, 'config', 'candidate.json'), 'utf8'));
  const who = { ...master.identity, ...cand.identity };
  const where = who.basedIn || who.location || 'your location';
  const tz = who.timezone || '';
  const auth = who.workAuthorization || 'See config/candidate.json — fill in your actual status.';
  const dir = join(ROOT, 'data', 'applications', String(job.id));
  const research = existsSync(join(dir, 'research.md')) ? readFileSync(join(dir, 'research.md'), 'utf8') : '';

  // The "why this company" answer has to come from the research, or it is the same paragraph
  // everyone else sends.
  // The bound used to be 400 characters, which was shorter than the section itself, so the
  // non-greedy match could never reach the next heading and silently found nothing.
  const hook = /## Three specific things to say[^\n]*\n+([\s\S]*?)(?=\n## |$)/.exec(research)?.[1]
    ?.replace(/^\s*\d+\.\s*/gm, '')
    .replace(/\*\*/g, '')
    .split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 4).join(' ')
    .slice(0, 600);

  return [
    { q: 'Are you legally authorised to work in this country?',
      m: 'authoris|authoriz|eligible to work|right to work|work permit',
      a: auth,
      note: 'Never soften this. It is checked, and a false answer burns the company as well as you.' },
    { q: 'Will you now or in the future require visa sponsorship?',
      m: 'sponsor|visa',
      a: `Yes, for roles that require working from a specific country. For a globally remote role, no — I work from ${where}.` },
    { q: 'Where are you located / what is your time zone?',
      m: 'time ?zone|timezone|where are you|current location|based\\?',
      a: `${where}${tz ? ` (${tz})` : ''}.`,
      note: 'Add your usable overlap hours here — it is the question remote teams actually care about.' },
    { q: 'Notice period / earliest start date',
      m: 'notice period|start date|available to start|earliest',
      a: '', note: 'Fill this in yourself — it depends on your current employment.' },
    { q: 'Salary expectations',
      m: 'salary expectation|compensation expectation|expected (?:salary|ctc)|desired salary',
      a: '', note: `Your band for this track is set in config/candidate.json. ${job.salary_min ? `This posting states ${job.salary_min}–${job.salary_max} ${job.salary_currency}.` : 'This posting publishes nothing, so ask rather than anchoring first.'}` },
    { q: 'Why do you want to work here?',
      m: 'why do you want|why are you interested|why this (?:company|role)|why us|interested in (?:joining|working)|motivat',
      a: hook || '', note: hook ? 'Drawn from the research dossier.' : 'No research dossier yet — run the researcher first, or this answer will be generic.' },
    { q: 'Years of experience',
      m: 'years of experience|experience do you have|total experience',
      a: 'About 1 year of professional experience, plus self-directed projects.' },
    { q: 'How did you hear about us?',
      m: 'hear about|how did you find|referral source',
      a: 'Found the posting directly on your careers page.' },
  ];
}

/**
 * The bookmarklet.
 *
 * Deliberately conservative: it matches fields by label, name, id, placeholder and autocomplete,
 * skips anything already filled, skips password and file inputs entirely, and outlines everything it
 * touched so nothing is changed invisibly. It cannot submit — there is no code path that clicks.
 */
export function bookmarklet(job) {
  const fields = profileFields();
  const answers = screeningAnswers(job).filter((a) => a.a);

  const payload = {
    f: fields,
    a: answers.map((x) => ({ q: x.q, a: x.a, m: x.m || null })),
  };

  const script = `(function(){
  var D=${JSON.stringify(payload)};
  var MAP=[
    [/first\\s*name|given\\s*name|fname/i,D.f.firstName],
    [/last\\s*name|family\\s*name|surname|lname/i,D.f.lastName],
    [/full\\s*name|^name$|your\\s*name|candidate\\s*name/i,D.f.fullName],
    [/e-?mail/i,D.f.email],
    [/phone|mobile|contact\\s*number/i,D.f.phone],
    [/linked\\s*in/i,D.f.linkedin],
    [/github/i,D.f.github],
    [/website|portfolio|personal\\s*site/i,D.f.website],
    [/city|town/i,D.f.city],
    [/country/i,D.f.country],
    [/location|where.*based|current\\s*residence/i,D.f.location]
  ];
  function label(el){
    var t='';
    if(el.id){var l=document.querySelector('label[for="'+CSS.escape(el.id)+'"]');if(l)t+=' '+l.innerText;}
    var p=el.closest('label');if(p)t+=' '+p.innerText;
    var w=el.closest('div,fieldset,li');if(w)t+=' '+(w.querySelector('label,legend')||{}).innerText||'';
    return (t+' '+(el.name||'')+' '+(el.id||'')+' '+(el.placeholder||'')+' '+(el.getAttribute('aria-label')||'')+' '+(el.autocomplete||'')).toLowerCase();
  }
  function set(el,v){
    var proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement:HTMLInputElement;
    var setter=Object.getOwnPropertyDescriptor(proto.prototype,'value').set;
    setter.call(el,v);
    el.dispatchEvent(new Event('input',{bubbles:true}));
    el.dispatchEvent(new Event('change',{bubbles:true}));
    el.style.outline='2px solid #f5a524';
  }
  var filled=0,skipped=[];
  document.querySelectorAll('input,textarea').forEach(function(el){
    var ty=(el.type||'').toLowerCase();
    if(['password','file','hidden','submit','button','checkbox','radio'].indexOf(ty)>=0)return;
    if(el.value&&el.value.trim())return;
    var L=label(el);
    function tryAnswers(){
      for(var j=0;j<D.a.length;j++){
        if(D.a[j].m&&new RegExp(D.a[j].m,'i').test(L)){set(el,D.a[j].a);filled++;return true;}
      }
      for(var k=0;k<D.a.length;k++){
        var key=D.a[k].q.toLowerCase().replace(/[^a-z ]/g,'').split(' ').filter(function(w){return w.length>4;});
        if(key.length<2)continue;
        var hits=key.filter(function(w){return L.indexOf(w)>=0;}).length;
        if(hits>=2){set(el,D.a[k].a);filled++;return true;}
      }
      return false;
    }
    function tryFields(){
      for(var i=0;i<MAP.length;i++){
        if(MAP[i][0].test(L)&&MAP[i][1]){set(el,MAP[i][1]);filled++;return true;}
      }
      return false;
    }
    var isQuestion=L.indexOf('?')>=0||el.tagName==='TEXTAREA'||L.length>60;
    if(isQuestion?(tryAnswers()||tryFields()):(tryFields()||tryAnswers()))return;
    if(L.trim())skipped.push(L.trim().slice(0,50));
  });
  var box=document.createElement('div');
  box.style.cssText='position:fixed;z-index:2147483647;right:16px;bottom:16px;max-width:340px;background:#151a21;color:#e6ebf2;border:1px solid #f5a524;border-radius:10px;padding:14px 16px;font:13px/1.5 system-ui,sans-serif;box-shadow:0 10px 34px rgba(0,0,0,.5)';
  box.innerHTML='<b style="color:#f5a524">Filled '+filled+' field'+(filled===1?'':'s')+'</b>'
    +'<div style="margin-top:8px;color:#8b97a8">Nothing was submitted. Check every field, attach your resume yourself, then press Submit.</div>'
    +(skipped.length?'<div style="margin-top:8px;color:#8b97a8">Left for you: '+skipped.slice(0,5).join('; ')+'</div>':'')
    +'<div style="margin-top:10px"><button id="amm-x" style="background:#f5a524;border:0;border-radius:6px;padding:5px 10px;cursor:pointer">OK</button></div>';
  document.body.appendChild(box);
  box.querySelector('#amm-x').onclick=function(){box.remove();};
})();`;

  // Newlines are stripped to make a one-line bookmarklet, which means a single // comment left in
  // the script above would comment out everything after it. They are removed first, deliberately.
  const oneLine = script
    .split('\n')
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('')
    .replace(/\s{2,}/g, ' ');
  return 'javascript:' + encodeURIComponent(oneLine);
}

export function applyPack(jobId) {
  const job = db().prepare('SELECT * FROM jobs WHERE id = ?').get(Number(jobId));
  if (!job) return null;
  const app = db().prepare('SELECT * FROM applications WHERE job_id = ? ORDER BY id DESC LIMIT 1').get(job.id);
  return {
    job: { id: job.id, title: job.title, company: job.company, apply_url: job.apply_url || job.url },
    approved: !!app?.approved_at,
    resume: app?.resume_path ? app.resume_path.split('/').pop() : null,
    fields: profileFields(),
    answers: screeningAnswers(job),
    bookmarklet: bookmarklet(job),
  };
}
