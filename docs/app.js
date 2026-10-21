'use strict';
/* Vitals: a read-only viewer. Everything shown is recomputed here from the CSV and the
   fact bank with the same lib.js that runs inside the n8n workflow. The model's raw proposals
   (themes, keywords, quote ids, wording) are loaded from data/snapshot.json. */

const VIEWS = [
  ['overview', 'Overview'], ['reviews', 'Reviews'], ['insights', 'Insights'], ['note', 'Weekly note'], ['fee', 'Fee explainer'],
  ['approval', 'Approval'], ['checks', 'Checks'], ['about', 'How it works']
];
const S = {}; // state

function e(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function parseCsvText(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.length > 1 || row[0] !== '') rows.push(row); row = []; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  const head = rows.shift();
  return { head: head.map(h => h.trim()), rows: rows.map(r => { const o = {}; head.forEach((h, i) => { o[h.trim()] = r[i] === undefined ? '' : r[i]; }); return o; }) };
}
async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
async function getText(p) { const r = await fetch(p); if (!r.ok) throw new Error(p + ' (' + r.status + ')'); return r.text(); }

async function compute() {
  const [csvText, bankText, snapText, mcpText, mainText] = await Promise.all(['data/reviews.csv', 'data/fee_facts.json', 'data/snapshot.json', 'n8n/mcp-server.json', 'n8n/review-pulse-main.json'].map(getText));
  const csv = parseCsvText(csvText);
  S.csvHead = csv.head;
  const bank = JSON.parse(bankText); S.bank = bank;
  const snap = JSON.parse(snapText); S.snap = snap;
  S.mcp = JSON.parse(mcpText); S.main = JSON.parse(mainText);
  const cleaned = cleanReviews(csv.rows, { windowWeeks: 12 });
  S.reviews = cleaned.reviews; S.stats = cleaned.stats;
  const ins = buildInsights(snap.llm1, S.reviews, bank, { stats: S.stats, runDate: snap.run_date });
  const l2 = snap.llm2 || {};
  const pulse = assemblePulse(ins, { observation: l2.observation, actions: l2.actions });
  const expl = assembleExplainer(ins.fee_issue.id, bank, l2.explainer_bullets);
  const payload = buildPayload(ins, pulse, expl);
  const docEntry = buildDocEntry(payload.entry);
  S.ins = ins; S.pulse = pulse; S.expl = expl; S.payload = payload; S.docEntry = docEntry;
  S.fingerprint = await sha256(docEntry);
  S.modelUsed = !!snap.llm1;
  const proposed = (snap.llm1 && Array.isArray(snap.llm1.themes) ? snap.llm1.themes : DEFAULT_THEMES).slice(0, 5).map(t => ({ name: t.name, keywords: t.keywords.map(normText).filter(Boolean), one_line: t.one_line }));
  S.themeOf = {}; tagThemes(S.reviews, proposed).themes.forEach(t => t.ids.forEach(id => { S.themeOf[id] = t.name; }));
  S.weekly = weeklyConfused(S.reviews, ins.fee_issue.id);
  S.rf = { q: '', stars: 'all', theme: 'all', fee: false, page: 0 };
  S.checks = runChecks();
}

function weeklyConfused(reviews, feeId) {
  const monday = d => { const t = new Date(d + 'T00:00:00Z'); const day = (t.getUTCDay() + 6) % 7; t.setUTCDate(t.getUTCDate() - day); return t.toISOString().slice(0, 10); };
  const weeks = {};
  reviews.forEach(r => {
    const w = monday(r.date); weeks[w] = weeks[w] || { named: 0, confused: 0 };
    for (let i = 0; i < FEE_TYPES.length; i++) {
      if (FEE_TYPES[i].re.test(r.text)) { if (FEE_TYPES[i].id === feeId) { weeks[w].named++; if (CONFUSE_RE.test(r.text)) weeks[w].confused++; } break; }
    }
  });
  return Object.keys(weeks).sort().map(w => ({ week: w, named: weeks[w].named, confused: weeks[w].confused }));
}
function isFeeConfused(r, feeId) {
  for (let i = 0; i < FEE_TYPES.length; i++) if (FEE_TYPES[i].re.test(r.text)) return FEE_TYPES[i].id === feeId && CONFUSE_RE.test(r.text);
  return false;
}

function runChecks() {
  const { ins, pulse, expl, payload, reviews, stats, bank, mcp, main, csvHead } = S;
  const out = []; const add = (area, name, ok, detail) => out.push({ area, name, ok: !!ok, detail });
  const spanDays = (new Date(stats.date_to) - new Date(stats.date_from)) / 86400000;
  add('Data', 'Reviews cover 8 to 12 weeks', spanDays >= 56 && spanDays <= 84, fmtDate(stats.date_from) + ' to ' + fmtDate(stats.date_to) + ' = ' + Math.round(spanDays / 7 * 10) / 10 + ' weeks');
  add('Data', 'Required columns present', ['date', 'rating', 'review'].every(c => csvHead.includes(c)), csvHead.join(', '));
  add('Data', 'No names or emails stored', !csvHead.some(c => /name|email|user|author/i.test(c)), 'Reviewer names are dropped at export');
  const pii = reviews.filter(r => /[\w.+-]+@[\w-]+\.[\w.]+|\b\d{10}\b|\b[A-Z]{5}\d{4}[A-Z]\b/.test(r.text)).length;
  add('Data', 'No personal data left in cleaned reviews', pii === 0, pii + ' reviews with an email, phone number or PAN; ' + stats.pii_redacted + ' redacted before analysis');
  add('Themes', 'At most 5 themes, exactly 3 at the top', ins.themes.length <= 5 && ins.top_themes.length === 3, ins.themes.length + ' themes, ' + ins.top_themes.length + ' ranked');
  const sorted = ins.top_themes.every((t, i, a) => !i || a[i - 1].low_count >= t.low_count);
  add('Themes', 'Ranking rule holds (most 1-2 star reviews first)', sorted, ins.top_themes.map(t => t.low_count).join(' ≥ '));
  const byId = {}; reviews.forEach(r => { byId[r.id] = r; });
  const idsOk = ins.themes.every(t => t.low_count <= t.count && t.count <= reviews.length);
  add('Themes', 'Theme counts are consistent with the data', idsOk && ins.themes.reduce((a, t) => a + t.count, 0) <= reviews.length, 'Sum of theme counts ≤ ' + reviews.length + ' reviews');
  const qok = ins.quotes.length === 3 && ins.quotes.every(q => byId[q.review_id] && normText(byId[q.review_id].text).includes(normText(q.text).replace(/ …$/, '').replace(/…$/, '').trim()));
  add('Quotes', 'Three quotes, each found word for word in its review', qok, ins.quotes.length + ' quotes checked against the original text');
  const words250 = pulse.words <= 250;
  add('Note', 'Under 250 words', words250, pulse.words + ' words');
  add('Note', 'All four sections present', ['Top themes', 'What users said', 'Key observation', 'Actions'].every(s => pulse.markdown.includes('## ' + s)), 'Top themes, quotes, key observation, actions');
  add('Note', 'Exactly three actions', (pulse.markdown.split('## Actions')[1] || '').trim().split('\n').filter(Boolean).length === 3, '');
  add('Explainer', 'At most 6 bullets', expl.bullets.length <= 6, expl.bullets.length + ' bullets');
  add('Explainer', 'Two official links and a Last checked date', expl.links.length === 2 && expl.links.every(l => /^https:\/\/groww\.in\//.test(l.url)) && !!expl.last_checked, expl.links.map(l => l.url.replace('https://', '')).join(' · ') + ' · ' + expl.last_checked);
  const allowedNums = new Set(numbersIn(bank.entries[ins.fee_issue.id].facts.join(' ')));
  add('Explainer', 'Every number comes from the official pages', expl.bullets.every(b => numbersIn(b).every(n => allowedNums.has(n))), 'Rupee amounts and percentages checked against the fact bank');
  add('Explainer', 'Neutral tone: no advice or opinion words', !expl.bullets.some(b => BANNED_EXPLAINER.test(b)), '');
  add('Fee', 'Fee issue chosen from the counts, not by hand', ins.fee_issue.candidates[0].id === ins.fee_issue.id, ins.fee_issue.name + ': ' + ins.fee_issue.confused + ' of ' + ins.fee_issue.named);
  const fields = ['date', 'top_themes', 'weekly_pulse', 'identified_fee_issue', 'explanation_bullets', 'source_links'];
  add('Doc entry', 'All six required fields present', fields.every(f => f in payload.entry && payload.entry[f] && payload.entry[f].length), fields.join(', '));
  add('Email', 'Subject follows the brief', payload.email.subject === 'Weekly Product Pulse + Customer Clarification — ' + fmtDate(S.snap.run_date), payload.email.subject);
  const tools = main && mcp ? mcp.nodes.filter(n => /Tool$/.test(n.type)).map(n => n.name).sort() : [];
  add('Safety', 'MCP server exposes exactly two tools', tools.join() === 'append_to_doc,create_email_draft', tools.join(', '));
  const gm = mcp.nodes.find(n => n.name === 'create_email_draft');
  add('Safety', 'Gmail tool can only create a draft', gm && gm.parameters.resource === 'draft' && gm.parameters.operation === 'create' && !mcp.nodes.some(n => /send(?!To)/i.test(String((n.parameters || {}).operation || ''))), 'No send operation anywhere in the server workflow');
  const ap = main.nodes.find(n => n.name === 'Ask for approval');
  const into = t => Object.entries(main.connections).filter(([, c]) => Object.values(c).some(o => o.some(l => l.some(x => x.node === t)))).map(([s]) => s);
  add('Safety', 'Nothing is published without the approval gate', ap && ap.parameters.operation === 'sendAndWait' && into('Build MCP instructions').join() === 'Approved?' && into('Approved?').join() === 'Ask for approval', 'Ask for approval → Approved? → Build MCP instructions');
  return out;
}

/* ---------- views ---------- */
function stat(n, l) { return '<div class="card stat"><div class="n">' + n + '</div><div class="l">' + l + '</div></div>'; }
function banner() {
  return S.modelUsed ? '' : '<p class="note"><b>Model snapshot not loaded.</b> Themes below use the built-in default taxonomy, not the model\'s proposal.</p>';
}
function vOverview() {
  const { stats, ins, pulse } = S; const t = ins.top_themes[0], f = ins.fee_issue;
  const passed = S.checks.filter(c => c.ok).length;
  return banner() + '<h1>Your product\'s weekly vitals, from 12 weeks of Groww reviews.</h1>' +
    '<p class="lede"><b>Every number, verified.</b> Public Play Store reviews go in. A verified product note and a neutral fee explainer come out. Nothing is published until a person approves it. Every number on this page is recomputed in your browser.</p>' +
    '<div class="grid g4">' +
    stat(stats.kept.toLocaleString('en-IN'), 'reviews analysed, ' + fmtDate(stats.date_from) + ' to ' + fmtDate(stats.date_to)) +
    stat(stats.avg_rating + ' ★', stats.low_star_pct + '% of reviews are 1 or 2 stars') +
    stat(e(t.low_count), 'unhappy reviews about “' + e(t.name) + '”, the top pain theme') +
    stat(f.confused + ' of ' + f.named, 'reviews naming “' + e(f.name.toLowerCase()) + '” call it hidden or unclear (' + f.confusion_rate_pct + '%)') +
    '</div>' +
    '<h2>What the model does, and what the code does</h2>' +
    '<div class="flow">' +
    '<div><b>Clean</b><span class="c">CODE</span> Drops duplicates, one-word reviews and personal data.</div>' +
    '<div><b>Propose</b><span class="m">MODEL</span> Suggests themes, keywords and candidate quotes.</div>' +
    '<div><b>Count and rank</b><span class="c">CODE</span> Counts every review. Ranks by 1-2 star reviews.</div>' +
    '<div><b>Verify</b><span class="c">CODE</span> Quotes must exist word for word. Numbers must come from inputs.</div>' +
    '<div><b>Write</b><span class="m">MODEL</span> One observation, three actions, explainer wording.</div>' +
    '<div><b>Approve</b><span class="c">HUMAN</span> Email with Approve or Reject. Only then the Doc and a draft.</div>' +
    '</div>' +
    '<p style="margin-top:22px" class="row"><a class="btn" href="#note">Read the weekly note</a><a class="btn ghost" href="#checks">' + passed + ' of ' + S.checks.length + ' checks passing</a></p>';
}
function filteredReviews() {
  const f = S.rf, q = normText(f.q);
  return S.reviews.filter(r => (f.stars === 'all' || (f.stars === 'low' && r.rating <= 2) || (f.stars === 'mid' && r.rating === 3) || (f.stars === 'high' && r.rating >= 4)) &&
    (f.theme === 'all' || S.themeOf[r.id] === f.theme) && (!f.fee || isFeeConfused(r, S.ins.fee_issue.id)) && (!q || normText(r.text).includes(q) || r.id.startsWith(q)));
}
function reviewList() {
  const list = filteredReviews(), per = 20, pages = Math.max(1, Math.ceil(list.length / per)); S.rf.page = Math.min(S.rf.page, pages - 1);
  const rows = list.slice(S.rf.page * per, S.rf.page * per + per);
  return '<p style="color:var(--ink-2)"><b>' + list.length.toLocaleString('en-IN') + '</b> of ' + S.reviews.length.toLocaleString('en-IN') + ' reviews</p>' +
    (rows.length ? rows.map(r => '<div class="card" style="margin-bottom:10px"><div class="row" style="justify-content:space-between"><span><b>' + r.rating + ' ★</b> · ' + fmtDate(r.date) + (S.themeOf[r.id] ? ' · <span class="pill">' + e(S.themeOf[r.id]) + '</span>' : '') + '</span><span style="color:var(--ink-2);font-size:12px">' + e(r.id) + '</span></div><p style="margin:8px 0 0">' + e(r.text) + '</p></div>').join('') : '<p class="note">No reviews match these filters.</p>') +
    '<div class="row" style="margin-top:12px"><button class="ghost" id="prev"' + (S.rf.page ? '' : ' disabled') + '>Previous</button><span>Page ' + (S.rf.page + 1) + ' of ' + pages + '</span><button class="ghost" id="next"' + (S.rf.page < pages - 1 ? '' : ' disabled') + '>Next</button></div>';
}
function vReviews() {
  const f = S.rf, opt = (v, l, cur) => '<option value="' + e(v) + '"' + (cur === v ? ' selected' : '') + '>' + e(l) + '</option>';
  return banner() + '<h1>The reviews behind the numbers</h1><p class="lede">Every count on this site comes from these reviews. Search them, filter by stars or theme, or look only at reviews that call the chosen charge hidden or unclear.</p>' +
    '<div class="card"><div class="grid g4"><div><label>Search text or review id<input type="text" id="q" value="' + e(f.q) + '" placeholder="e.g. brokerage"></label></div>' +
    '<div><label>Stars<br><select id="stars">' + opt('all', 'All', f.stars) + opt('low', '1-2 stars', f.stars) + opt('mid', '3 stars', f.stars) + opt('high', '4-5 stars', f.stars) + '</select></label></div>' +
    '<div><label>Theme<br><select id="theme">' + opt('all', 'All themes', f.theme) + S.ins.themes.map(t => opt(t.name, t.name, f.theme)).join('') + '</select></label></div>' +
    '<div><label><br><input type="checkbox" id="fee"' + (f.fee ? ' checked' : '') + '> Only “' + e(S.ins.fee_issue.name.toLowerCase()) + '”: hidden or unclear</label></div></div></div>' +
    '<div id="rlist" style="margin-top:14px">' + reviewList() + '</div>';
}
function bindReviews() {
  const refresh = () => { document.getElementById('rlist').innerHTML = reviewList(); bindPager(); };
  const bindPager = () => { const p = document.getElementById('prev'), n = document.getElementById('next'); if (p) p.onclick = () => { S.rf.page--; refresh(); }; if (n) n.onclick = () => { S.rf.page++; refresh(); }; };
  document.getElementById('q').oninput = ev => { S.rf.q = ev.target.value; S.rf.page = 0; refresh(); };
  document.getElementById('stars').onchange = ev => { S.rf.stars = ev.target.value; S.rf.page = 0; refresh(); };
  document.getElementById('theme').onchange = ev => { S.rf.theme = ev.target.value; S.rf.page = 0; refresh(); };
  document.getElementById('fee').onchange = ev => { S.rf.fee = ev.target.checked; S.rf.page = 0; refresh(); };
  bindPager();
}

function vInsights() {
  const { ins } = S; const max = Math.max.apply(null, ins.themes.map(t => t.low_count));
  const row = (t, i, top) => '<div class="rank"><span class="no">' + (top ? i + 1 : '·') + '</span><span class="nm">' + e(t.name) + '</span><span class="val">' + t.low_count + ' low-star</span>' +
    '<div class="bar"><i style="width:' + Math.round(100 * t.low_count / max) + '%"></i></div>' +
    '<div class="sub">' + t.count + ' reviews (' + t.share_pct + '% of all) · average ' + t.avg_rating + ' ★ · ' + t.low_star_pct + '% of this theme is 1-2 star' + (t.one_line ? ' · ' + e(t.one_line) : '') + '</div></div>';
  const rest = ins.themes.filter(t => !ins.top_themes.find(x => x.name === t.name)).sort((a, b) => b.low_count - a.low_count);
  return banner() + '<h1>Where users are unhappy</h1>' +
    '<p class="lede">Themes are ranked by how many 1 and 2 star reviews they hold, not by size. The biggest theme is usually people saying “nice app”, which tells a product team nothing.</p>' +
    '<div class="card"><h3>Top 3 pain themes</h3>' + ins.top_themes.map((t, i) => row(t, i, true)).join('') + '</div>' +
    (rest.length ? '<div class="card" style="margin-top:14px"><h3>Other themes</h3>' + rest.map(t => row(t, 0, false)).join('') + '</div>' : '') +
    '<h2>What users said</h2><p class="lede" style="font-size:15px">Each quote is copied from a real review. The page checks that the words appear in the original text.</p>' +
    ins.quotes.map(q => {
      const r = S.reviews.find(x => x.id === q.review_id);
      const ok = r && normText(r.text).includes(normText(q.text).replace(/ …$/, '').replace(/…$/, '').trim());
      return '<blockquote class="quote"><p>“' + e(q.text) + '”</p><small>' + q.rating + (q.rating === 1 ? ' star' : ' stars') + ' · ' + fmtDate(q.date) + ' · review ' + e(q.review_id) + ' · ' +
        (ok ? '<span class="pill ok">verbatim ✓</span>' : '<span class="pill bad">not found</span>') + '</small></blockquote>';
    }).join('');
}
function vNote() {
  const { pulse } = S;
  return banner() + '<h1>The weekly note</h1><p class="lede">One minute to read. The brief caps it at 250 words.</p>' +
    '<div class="card"><div class="row" style="justify-content:space-between"><b>' + pulse.words + ' of 250 words</b><span class="pill ' + (pulse.words <= 250 ? 'ok' : 'bad') + '">' + (pulse.words <= 250 ? 'within limit' : 'over limit') + '</span></div>' +
    '<div class="meter"><i style="width:' + Math.min(100, Math.round(pulse.words / 2.5)) + '%"></i></div><hr style="border:0;border-top:1px solid var(--line);margin:14px 0">' +
    '<div class="note-body">' + e(pulse.markdown) + '</div></div>' +
    (pulse.flags.length ? '<p class="note">Fallbacks used: ' + pulse.flags.map(e).join('; ') + '</p>' : '');
}
function vFee() {
  const { ins, expl } = S; const f = ins.fee_issue;
  return banner() + '<h1>Fee confusion: ' + e(f.name.toLowerCase()) + '</h1>' +
    '<p class="lede">Found from the data: the charge that users most often describe as hidden, unexpected or unclear. A complaint that a charge is too high is a pricing question. Confusion is something support can fix this week.</p>' +
    '<div class="card scroll"><table><thead><tr><th>Charge users name</th><th class="num">Reviews naming it</th><th class="num">Hidden or unclear</th><th class="num">Share</th></tr></thead><tbody>' +
    f.candidates.map((c, i) => '<tr class="' + (i === 0 ? 'win' : '') + '"><td>' + e((S.bank.entries[c.id] || { name: c.id }).name) + (i === 0 ? ' ←' : '') + '</td><td class="num">' + c.named + '</td><td class="num">' + c.confused + '</td><td class="num">' + c.confusion_rate_pct + '%</td></tr>').join('') +
    '</tbody></table></div>' +
    '<p style="color:var(--ink-2);font-size:14px">' + e(f.summary) + ' Trend: ' + (f.trend && f.trend.direction === 'flat' ? 'steady week on week.' : e((f.trend || {}).direction || 'n/a') + '.') + '</p>' +
    '<h2>Hidden or unclear mentions, week by week</h2>' + weeklyChart() +
    '<h2>What support can send to a confused customer</h2><div class="card"><ul class="clean">' + expl.bullets.map(b => '<li>' + e(b) + '</li>').join('') + '</ul>' +
    '<p style="margin:14px 0 0;font-size:14px">Sources: ' + expl.links.map(l => '<a href="' + e(l.url) + '" target="_blank" rel="noopener">' + e(l.title) + '</a>').join(' · ') + '<br><b>Last checked: ' + e(expl.last_checked) + '</b></p></div>';
}
function weeklyChart() {
  const w = S.weekly, max = Math.max(1, Math.max.apply(null, w.map(x => x.confused)));
  const W = 960, H = 190, pad = 28, bw = (W - pad * 2) / w.length;
  const bars = w.map((x, i) => { const h = Math.round((H - 50) * x.confused / max), xx = pad + i * bw + 4;
    return '<rect x="' + xx + '" y="' + (H - 28 - h) + '" width="' + (bw - 8) + '" height="' + h + '" rx="4" fill="var(--bar)"/><text x="' + (xx + (bw - 8) / 2) + '" y="' + (H - 32 - h) + '" text-anchor="middle" font-size="12" fill="var(--ink)">' + x.confused + '</text>' +
      '<text x="' + (xx + (bw - 8) / 2) + '" y="' + (H - 10) + '" text-anchor="middle" font-size="11" fill="var(--ink-2)">' + e(fmtDate(x.week).replace(/ 20\d\d$/, '')) + '</text>'; }).join('');
  return '<div class="card scroll"><svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" role="img" aria-label="Hidden or unclear mentions per week">' + bars + '</svg><p style="margin:6px 0 0;color:var(--ink-2);font-size:13px">Weeks start on Monday. A mention counts when a review names the charge and calls it hidden, unexpected or unclear.</p></div>';
}
function emailPanel() {
  return '<h2>Email draft</h2><div class="card"><span class="pill warn">Draft, not sent</span><p style="margin:10px 0 4px"><b>Subject:</b> ' + e(S.payload.email.subject) + '</p><pre id="mailbody">' + e(S.payload.email.body) + '</pre>' +
    '<div class="row" style="margin-top:12px"><button id="copymail">Copy draft text</button><button class="ghost" id="emlmail">Download as .eml (unsent)</button></div>' +
    '<p style="color:var(--ink-2);font-size:13px;margin:10px 0 0">The real Gmail draft is created by n8n after approval. This copy is for reading.</p></div>';
}
function vApproval() {
  return banner() + '<h1>The approval gate</h1>' +
    '<p class="lede">Nothing is written to the Google Doc or Gmail until a person approves. The approval happens in n8n: a Gmail “Send and wait” step emails the exact text below with Approve and Reject buttons. Only the approved branch can reach the two tools, and the Gmail tool can only create a draft.</p>' +
    '<div class="grid g2"><div class="card"><h3>Exact text that will be logged</h3><pre>' + e(S.docEntry) + '</pre></div>' +
    '<div class="card"><h3>Email draft subject</h3><p style="margin:0 0 14px">' + e(S.payload.email.subject) + '</p><h3>Fingerprint (SHA-256)</h3><p class="fp">' + S.fingerprint + '</p>' +
    '<p style="color:var(--ink-2);font-size:14px">A short code that changes completely if even one character changes. Anyone can recompute it from the text.</p></div></div>' +
    '<h2>Check what was actually logged</h2><p class="lede" style="font-size:15px">Paste the entry from the Google Doc. The page hashes it and compares it with the fingerprint above.</p>' +
    '<textarea id="paste" placeholder="Paste the Doc entry here"></textarea><div class="row" style="margin-top:10px"><button id="verify">Compare</button><span id="vres"></span></div>' + emailPanel();
}
function vChecks() {
  const c = S.checks; const ok = c.filter(x => x.ok).length;
  const areas = []; c.forEach(x => { if (!areas.includes(x.area)) areas.push(x.area); });
  return banner() + '<h1>Checks</h1><p class="lede">' + ok + ' of ' + c.length + ' pass. They run live in your browser, with plain rules and no AI.</p>' +
    '<div class="card">' + areas.map(a => '<h3 style="margin-top:14px">' + e(a) + '</h3>' + c.filter(x => x.area === a).map(x => '<div class="chk"><span class="mark ' + (x.ok ? 'ok' : 'bad') + '">' + (x.ok ? '✓' : '✕') + '</span><div>' + e(x.name) + '<div class="d">' + e(x.detail) + '</div></div></div>').join('')).join('') + '</div>';
}
function vAbout() {
  return '<h1>How it works</h1><p class="lede">Two n8n workflows and a set of small code checks. The model proposes, the code decides.</p>' +
    '<div class="grid g2"><div class="card"><h3>Pipeline (n8n)</h3><ul class="clean"><li>Fetch the reviews CSV, clean it, remove personal data</li><li>Gemini proposes themes, keywords and quote candidates</li><li>Code counts, ranks and verifies quotes and numbers</li><li>Gemini writes the observation, three actions and explainer wording</li><li>Code enforces 250 words, 6 bullets, 2 links and neutral tone</li><li>Gmail “Send and wait” asks for approval</li><li>An agent calls two MCP tools: append to the Doc, create a Gmail draft</li></ul></div>' +
    '<div class="card"><h3>Where to look</h3><ul class="clean"><li><a href="https://github.com/Sushantmulmuley/vitals">GitHub repository and README</a></li><li><a href="data/reviews.csv">Reviews CSV (12 weeks, no names)</a></li><li><a href="data/fee_facts.json">Fee fact bank from official pages</a></li><li><a href="n8n/review-pulse-main.json">Main workflow JSON</a></li><li><a href="n8n/mcp-server.json">MCP server workflow JSON</a></li></ul></div></div>' +
    '<h2>Honest limits</h2><ul class="clean"><li>Reviews are user-written and unverified. Theme counts come from keyword matching, so spot-check them.</li><li>Fee facts are copied from public pages and can go stale. Check the Last checked date.</li><li>This page only displays and verifies. Approval and publishing happen in n8n.</li></ul>';
}
const RENDER = { overview: vOverview, reviews: vReviews, insights: vInsights, note: vNote, fee: vFee, approval: vApproval, checks: vChecks, about: vAbout };

function route() {
  const id = (location.hash || '#overview').slice(1); const v = RENDER[id] ? id : 'overview';
  $nav.innerHTML = VIEWS.map(([k, l]) => '<a href="#' + k + '"' + (k === v ? ' aria-current="page"' : '') + '>' + l + '</a>').join('');
  $app.innerHTML = RENDER[v]();
  document.title = VIEWS.find(x => x[0] === v)[1] + ' · Vitals';
  window.scrollTo(0, 0);
  if (v === 'reviews') bindReviews();
  if (v === 'approval') {
    document.getElementById('copymail').onclick = async ev => { try { await navigator.clipboard.writeText('Subject: ' + S.payload.email.subject + '\n\n' + S.payload.email.body); ev.target.textContent = 'Copied'; } catch (x) { ev.target.textContent = 'Copy failed'; } };
    document.getElementById('emlmail').onclick = () => {
      const eml = 'X-Unsent: 1\r\nSubject: ' + S.payload.email.subject + '\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n' + S.payload.email.body.replace(/\n/g, '\r\n');
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([eml], { type: 'message/rfc822' })); a.download = 'vitals-weekly-pulse-draft.eml'; a.click();
    };
    document.getElementById('verify').onclick = async () => {
      const t = document.getElementById('paste').value.replace(/\r\n/g, '\n');
      const norm = s => s.replace(/\s+$/g, '');
      const h = await sha256(t.endsWith('\n') ? t : t + '\n');
      const same = h === S.fingerprint || norm(t) === norm(S.docEntry);
      document.getElementById('vres').innerHTML = same ? '<span class="pill ok">Match: the logged text is what was approved</span>' : '<span class="pill bad">Different: the pasted text does not match</span>';
    };
  }
}
const $app = document.getElementById('app'), $nav = document.getElementById('nav');
window.addEventListener('hashchange', () => S.ins && route());
compute().then(route).catch(err => { $app.innerHTML = '<p class="err">Could not load: ' + e(err.message) + '</p>'; console.error(err); });
