// design-direction's pure parts: the picker state machine, the decision memory and the browser page.
// Ported from claude-mods design-direction (hooks/register.tsx:17-160). Two changes: the page draws
// every mockup as an <img> data URI instead of inlining model-written SVG (an inlined SVG could run
// script on the page that holds the answer token), and the page runs these same functions, so the
// tested state machine is the one the user clicks through.

// "Mix these": two options of a single-select question sent as one blended answer. The wording is what
// the model reads, so it stays exactly as the original has it.
export const MIX = ['Mix of "', '" and "', '": blend both directions into one design']

export function mixAnswer([a, b]) {
  return `${MIX[0]}${a}${MIX[1]}${b}${MIX[2]}`
}

export function canMix(q) {
  return !q.multiSelect && q.options.length > 1
}

export function isMixing(p, qi) {
  return Boolean(p.mix?.[qi])
}

export function newPicker(questions) {
  return { questions, picks: questions.map(() => []), others: questions.map(() => null), mix: questions.map(() => false) }
}

export function answersOf(p) {
  return Object.fromEntries(
    p.questions.map((q, i) => [
      q.question,
      p.others[i] ?? (isMixing(p, i) && p.picks[i]?.length === 2 ? mixAnswer(p.picks[i]) : p.picks[i]?.join(', ')) ?? '',
    ]),
  )
}

export function isComplete(p) {
  return p.questions.every((_, i) => p.others[i] || (isMixing(p, i) ? p.picks[i]?.length === 2 : p.picks[i]?.length))
}

// A press on an option: single-select replaces, multi-select toggles, mixing toggles up to two.
export function toggle(p, qi, label) {
  const q = p.questions[qi]
  const picks = p.picks.map((ls, i) => {
    if (i !== qi) return ls
    if (ls.includes(label) && (q.multiSelect || isMixing(p, i))) return ls.filter((l) => l !== label)
    if (isMixing(p, i)) return [...ls, label].slice(-2)
    return q.multiSelect ? [...ls, label] : [label]
  })
  return { ...p, picks, others: p.others.map((o, i) => (i === qi ? null : o)) }
}

export function toggleMix(p, qi) {
  return {
    ...p,
    mix: p.questions.map((_, i) => (i === qi ? !isMixing(p, i) : isMixing(p, i))),
    picks: p.picks.map((ls, i) => (i === qi && isMixing(p, i) ? ls.slice(0, 1) : ls)),
  }
}

// Typed text answers the question and clears its picks (the original page's behaviour).
export function setOther(p, qi, text) {
  return {
    ...p,
    others: p.others.map((o, i) => (i === qi ? String(text).trim() : o)),
    picks: p.picks.map((ls, i) => (i === qi ? [] : ls)),
  }
}

// What a submitted answer chose, with the picked options' descriptions, for the project's memory.
export function decisionsOf(qs, answers, at) {
  return qs.flatMap((q) => {
    const choice = String(answers?.[q.question] ?? '').trim()
    if (!choice) return []
    const byLabel = (l) => q.options.find((o) => o.label === l)
    const exact = byLabel(choice)
    const pairs = q.options.flatMap((a) => q.options.filter((b) => b !== a).map((b) => [a, b]))
    const mixed = pairs.find(([a, b]) => mixAnswer([a.label, b.label]) === choice)
    const parts = choice.split(', ')
    const options = exact
      ? [exact]
      : mixed
        ? [...mixed]
        : q.multiSelect && parts.every(byLabel)
          ? parts.map((l) => byLabel(l))
          : []
    const description = options.map((o) => o.description).filter(Boolean).join(' + ')
    return [{ question: q.question, ...(q.topic ? { topic: q.topic } : {}), choice, ...(description ? { description } : {}), at }]
  })
}

export const MAX_DECISIONS = 50

// Agents word the same question differently, so a topic ('palette', 'typography') identifies a
// decision when both sides have one; otherwise the question text does, as in the original.
export function sameDecision(a, b) {
  return a.topic && b.topic ? a.topic === b.topic : a.question === b.question
}

// The newest answer to a question replaces the older one.
export function mergeDecisions(old, added) {
  return [...old.filter((d) => !added.some((a) => sameDecision(a, d))), ...added].slice(-MAX_DECISIONS)
}

// Also accepts a leading <?xml ...?> prolog, which the original missed.
export function isSvg(s) {
  return typeof s === 'string' && /^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(s)
}

export function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
}

// An SVG in <img> is parsed as strict XML, where the inline SVG the original used was parsed as
// lenient HTML. Repair the two slips models make most, so the mockup draws instead of breaking: a
// root without the SVG namespace (and xlink: used without its namespace), and a bare '&'.
export function svgDataUri(svg) {
  let text = String(svg).replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/gi, '&amp;')
  const root = /<svg\b[^>]*>/i.exec(text)
  if (root) {
    const extra = []
    if (!/\sxmlns\s*=/i.test(root[0])) extra.push(' xmlns="http://www.w3.org/2000/svg"')
    if (/\bxlink:/i.test(text) && !/\sxmlns:xlink\s*=/i.test(text)) extra.push(' xmlns:xlink="http://www.w3.org/1999/xlink"')
    if (extra.length) text = `${text.slice(0, root.index + 4)}${extra.join('')}${text.slice(root.index + 4)}`
  }
  return `data:image/svg+xml;base64,${Buffer.from(text, 'utf8').toString('base64')}`
}

// JSON placed inside <script>: '<' escaped so no value can close the element.
function scriptJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

const PAGE_LOGIC = [isMixing, mixAnswer, newPicker, answersOf, isComplete, toggle, toggleMix, setOther].map(String).join('\n')

const STYLE = `body{font:15px/1.4 system-ui,sans-serif;margin:24px;background:#f4f4f2;color:#1a1a1a}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:20px}
.card{all:unset;cursor:pointer;display:block;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 1px 3px #0002;outline:3px solid transparent;transition:outline-color .15s,transform .15s}
.card:hover{transform:translateY(-2px);outline-color:#0003}.card:focus-visible{outline-color:#2563eb}
.card.on{outline-color:#16a34a}
.card img{display:block;width:100%;height:auto}
.cap{display:block;padding:10px 14px;font-weight:600}small{display:block;font-weight:400;color:#666}
kbd{background:#1a1a1a;color:#fff;border-radius:4px;padding:1px 7px;margin-right:6px}
.other{margin-top:12px;width:100%;max-width:480px;padding:8px 10px;border:1px solid #ccc;border-radius:6px;font:inherit}
#submit{margin-top:24px;padding:10px 20px;border:0;border-radius:8px;background:#1a1a1a;color:#fff;font:inherit;cursor:pointer}
#submit:disabled{opacity:.3;cursor:default}
#close{margin-top:24px;margin-left:12px;padding:10px 20px;border:1px solid #ccc;border-radius:8px;background:none;font:inherit;cursor:pointer}
.mix{margin-top:12px;margin-right:12px;padding:7px 14px;border:1px solid #1a1a1a;border-radius:6px;background:#fff;font:inherit;cursor:pointer}
.mix.on{background:#16a34a;border-color:#16a34a;color:#fff}`

// The page posts { answers } (or { closed: true }) to /answer/<token>. Served only with the CSP from
// design-server.mjs: nothing runs or loads unless it carries this page's nonce or is a data: image.
export function galleryHtml(qs, { token, nonce, agent = null, project = '' }) {
  let n = 0
  const sections = qs.map((q, qi) => `
<section><h2>${esc(q.header)}</h2><p>${esc(q.question)}${q.multiSelect ? ' <em>(pick any)</em>' : ''}</p><div class="grid">${q.options
    .map((o) => `<button class="card" data-q="${qi}" data-label="${esc(o.label)}">${isSvg(o.svg) ? `<img src="${svgDataUri(o.svg)}" alt="">` : ''}<span class="cap"><kbd>${++n}</kbd> ${esc(o.label)}${
      o.description ? `<small>${esc(o.description)}</small>` : ''
    }</span></button>`)
    .join('')}</div>${
    canMix(q) ? `<button class="mix" data-q="${qi}">Mix two</button>` : ''
  }<input class="other" data-q="${qi}" placeholder="Or describe your own, then Enter"></section>`)
  const needsSubmit = qs.length > 1 || qs.some((q) => q.multiSelect)
  const who = agent || 'your agent'
  const title = `${agent ? `${agent} · ` : ''}${project}: Design direction`
  const meta = qs.map((q) => ({ question: q.question, multiSelect: Boolean(q.multiSelect) }))

  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><title>${esc(title)}</title>
<style nonce="${esc(nonce)}">
${STYLE}
</style>${sections.join('')}
<div><button id="submit" disabled${needsSubmit ? '' : ' hidden'}>Send to ${esc(who)}</button><button id="close">Close without choosing</button></div>
<script nonce="${esc(nonce)}">
const MIX=${scriptJson(MIX)};
${PAGE_LOGIC}
const A=${scriptJson(who)}, T=${scriptJson(token)}, auto=${!needsSubmit};
let p=newPicker(${scriptJson(meta)}), sent=false;
const all=s=>[...document.querySelectorAll(s)];
const done=t=>{const h=document.createElement('h1'),s=document.createElement('p');h.textContent=t;s.textContent='You can close this tab.';document.body.replaceChildren(h,s)};
const post=(body,t)=>{if(sent)return;sent=true;fetch('/answer/'+T,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
  .then(r=>{if(!r.ok)throw 0;done(t)})
  .catch(()=>{sent=false;alert(A+' is no longer waiting for this answer.')})};
const send=()=>post({answers:answersOf(p)},'Sent to '+A+' ✓');
const sync=()=>{all('.card').forEach(c=>c.classList.toggle('on',p.picks[+c.dataset.q].includes(c.dataset.label)));
  all('.mix').forEach(b=>{const on=isMixing(p,+b.dataset.q);b.classList.toggle('on',on);b.textContent=on?'Mixing: pick two':'Mix two'});
  const s=document.getElementById('submit');s.hidden=auto&&!p.mix.some(Boolean);s.disabled=!isComplete(p)};
all('.card').forEach(c=>c.onclick=()=>{const i=+c.dataset.q;p=toggle(p,i,c.dataset.label);sync();if(auto&&!isMixing(p,i))send()});
all('.mix').forEach(b=>b.onclick=()=>{p=toggleMix(p,+b.dataset.q);sync()});
all('.other').forEach(o=>o.onkeydown=e=>{if(e.key!=='Enter'||!o.value.trim())return;p=setOther(p,+o.dataset.q,o.value);sync();if(auto)send()});
document.getElementById('submit').onclick=send;
document.getElementById('close').onclick=()=>post({closed:true},'Closed without choosing');
const cards=all('.card');
document.onkeydown=e=>{if(e.target.tagName!=='INPUT'&&/^[1-9]$/.test(e.key))cards[e.key-1]?.click()};
</script>`
}
