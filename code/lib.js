'use strict';
/*
 * lib.js: single source of truth for every Code node in the n8n workflow.
 * build_workflow.js inlines this file into each Code node (n8n Code nodes cannot
 * require local files), and tests/ run the very same functions in plain Node.
 * No dependencies, no network.
 *
 * Division of labour:
 *   - the model proposes (theme names + keywords, quotes, fee wording, actions)
 *   - this file decides (counts, ranking, which fee, quote verification,
 *     word limits, number checks, fallbacks)
 */

const BANNED_EXPLAINER = /\b(should|must|recommend\w*|best|better|worse|avoid|worth|advis\w*|switch|cheap\w*|expensive|unfair|scam|fraud\w*|rip[- ]?off)\b/i;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ---------- small helpers ----------
function normText(s) { return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim(); }
function words(s) { const t = String(s == null ? '' : s).trim(); return t ? t.split(/\s+/).length : 0; }
function round(n, d) { const f = Math.pow(10, d == null ? 1 : d); return Math.round(n * f) / f; }
function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function iso(d) { return d.toISOString().slice(0, 10); }
function fmtDate(isoStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(isoStr));
  if (!m) return String(isoStr);
  return parseInt(m[3], 10) + ' ' + MONTHS[parseInt(m[2], 10) - 1] + ' ' + m[1];
}
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; }
  return a;
}
function numbersIn(s) {
  return (String(s).match(/\d[\d,]*(?:\.\d+)?/g) || []).map(function (x) { return x.replace(/,/g, ''); });
}
function numbersAllowed(text, allowedSet) {
  return numbersIn(text).every(function (n) { return allowedSet.has(n); });
}

// ---------- 1. clean ----------
const PII = [
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[EMAIL]'],
  [/\b[A-Za-z]{5}\d{4}[A-Za-z]\b/g, '[PAN]'],
  [/(?:\+?91[\s-]?)?\b[6-9]\d{9}\b/g, '[PHONE]'],
  [/\b\d{4}\s?\d{4}\s?\d{4}\b/g, '[ID]']
];
function stripPII(text) {
  let out = text, hit = false;
  PII.forEach(function (p) { out = out.replace(p[0], function () { hit = true; return p[1]; }); });
  return { text: out, hit: hit };
}
function pick(row, keys) {
  for (let i = 0; i < keys.length; i++) {
    const v = row[keys[i]];
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return '';
}
function parseDate(raw) {
  let s = String(raw).trim().replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += 'T00:00:00';
  if (!/[zZ]$|[+-]\d\d:?\d\d$/.test(s)) s += 'Z';
  return new Date(s);
}

/** rows: array of plain objects from the CSV. Returns {reviews, stats}. */
function cleanReviews(rows, opts) {
  opts = opts || {};
  const minWords = opts.minWords || 5;
  const windowWeeks = opts.windowWeeks || 12;
  const stats = { rows_in: rows.length, dropped_bad_row: 0, dropped_duplicate: 0, dropped_short: 0, dropped_outside_window: 0, pii_redacted: 0 };
  let items = [];
  rows.forEach(function (r, i) {
    const text = String(pick(r, ['review', 'content', 'text', 'Review', 'review_text'])).replace(/\s+/g, ' ').trim();
    const rating = parseInt(pick(r, ['rating', 'score', 'Rating', 'stars']), 10);
    const d = parseDate(pick(r, ['date', 'at', 'Date', 'review_date']));
    if (!text || !(rating >= 1 && rating <= 5) || isNaN(d.getTime())) { stats.dropped_bad_row++; return; }
    items.push({
      id: String(pick(r, ['review_id', 'reviewId', 'id']) || ('r' + (i + 1))),
      d: d, rating: rating, text: text,
      thumbs: parseInt(pick(r, ['thumbs_up', 'thumbsUpCount', 'helpful']), 10) || 0
    });
  });
  items.sort(function (a, b) { return b.d - a.d; });
  const seen = new Set();
  items = items.filter(function (r) {
    const k = normText(r.text);
    if (seen.has(k)) { stats.dropped_duplicate++; return false; }
    seen.add(k); return true;
  });
  items = items.filter(function (r) {
    if (words(r.text) < minWords) { stats.dropped_short++; return false; }
    return true;
  });
  if (items.length) {
    const cutoff = items[0].d.getTime() - windowWeeks * 7 * 86400000;
    items = items.filter(function (r) {
      if (r.d.getTime() < cutoff) { stats.dropped_outside_window++; return false; }
      return true;
    });
  }
  const reviews = items.map(function (r) {
    const p = stripPII(r.text);
    if (p.hit) stats.pii_redacted++;
    return { id: r.id, date: iso(r.d), rating: r.rating, text: p.text, thumbs: r.thumbs };
  });
  stats.kept = reviews.length;
  if (reviews.length) {
    stats.date_from = reviews[reviews.length - 1].date;
    stats.date_to = reviews[0].date;
    stats.avg_rating = round(reviews.reduce(function (a, r) { return a + r.rating; }, 0) / reviews.length, 2);
    stats.low_star_pct = round(100 * reviews.filter(function (r) { return r.rating <= 2; }).length / reviews.length, 1);
  }
  return { reviews: reviews, stats: stats };
}

// ---------- 2. retrieval ----------
/** Deterministic stratified sample: half 1-2 star, 20% 3 star, 30% 4-5 star. */
function stratifiedSample(reviews, n, seed) {
  if (reviews.length <= n) return reviews.slice();
  const rng = mulberry32(seed == null ? 17 : seed);
  const groups = [
    { q: Math.round(n * 0.5), items: shuffle(reviews.filter(function (r) { return r.rating <= 2; }), rng) },
    { q: Math.round(n * 0.2), items: shuffle(reviews.filter(function (r) { return r.rating === 3; }), rng) },
    { q: n - Math.round(n * 0.5) - Math.round(n * 0.2), items: shuffle(reviews.filter(function (r) { return r.rating >= 4; }), rng) }
  ];
  let out = [];
  groups.forEach(function (g) { out = out.concat(g.items.slice(0, g.q)); g.rest = g.items.slice(g.q); });
  const leftovers = [].concat.apply([], groups.map(function (g) { return g.rest; }));
  if (out.length < n) out = out.concat(shuffle(leftovers, rng).slice(0, n - out.length));
  return out.sort(function (a, b) { return a.date < b.date ? 1 : -1; });
}
function contextLines(reviews, maxChars) {
  return reviews.map(function (r) { return r.id + ' | ' + r.rating + '* | ' + r.text.slice(0, maxChars || 260); }).join('\n');
}

// Charge types, in priority order. A review counts once, under the first type it matches.
const FEE_TYPES = [
  { id: 'auto_square_off', re: /square[\s-]?off/i },
  { id: 'mtf_interest', re: /\bmtf\b|margin trading|\bpledge\b/i },
  { id: 'dp_charges', re: /\bdp\b|depository/i },
  { id: 'gst_taxes', re: /\bgst\b|\bstt\b|stamp duty|\btaxes?\b/i },
  { id: 'brokerage', re: /brokerage|commission/i },
  { id: 'overall_charges', re: /\bhidden\b.*\b(charges?|fees?)\b|\bextra (charges?|money|amount)\b|\bdeduct\w*|\bcharged\b|\bcharges\b|\bfees?\b/i }
];
const CONFUSE_RE = /\b(hidden|unexpected(?:ly)?|didn'?t know|did not know|not told|no one told|without (?:informing|notice|telling|asking)|why|what is this|explain\w*|unclear|confus\w*|misleading|not mentioned|never told|bina bataye|bina bataaye|pata nahi|kyun|kyu|zero brokerage|extra)\b/i;

/** Which charge users name, and how often they also say it was unexpected or unclear. */
function feeTable(reviews, bankIds, dateTo) {
  const rows = {};
  const end = dateTo ? new Date(dateTo + 'T23:59:59Z').getTime() : 0;
  FEE_TYPES.forEach(function (t) { rows[t.id] = { id: t.id, named: 0, confused: 0, evidence: [], recent: 0, earlier: 0 }; });
  reviews.forEach(function (r) {
    for (let i = 0; i < FEE_TYPES.length; i++) {
      if (FEE_TYPES[i].re.test(r.text)) {
        const row = rows[FEE_TYPES[i].id];
        row.named++;
        if (CONFUSE_RE.test(r.text)) {
          row.confused++; row.evidence.push(r);
          if (end) { if (Math.floor((end - new Date(r.date + 'T00:00:00Z').getTime()) / (7 * 86400000)) < 4) row.recent++; else row.earlier++; }
        }
        break;
      }
    }
  });
  return Object.keys(rows).map(function (k) {
    const row = rows[k];
    row.confusion_rate_pct = row.named ? round(100 * row.confused / row.named, 1) : 0;
    row.evidence = row.evidence.sort(function (a, b) { return (b.thumbs - a.thumbs) || (b.rating < a.rating ? 1 : -1); })
      .slice(0, 4).map(function (r) { return { id: r.id, rating: r.rating, text: r.text.slice(0, 260) }; });
    return row;
  }).filter(function (r) { return r.named > 0 && (!bankIds || bankIds.indexOf(r.id) >= 0); })
    .sort(function (a, b) { return (b.confused - a.confused) || (b.named - a.named); });
}

// ---------- 3. themes ----------
function tagThemes(reviews, themes) {
  const buckets = themes.map(function (t) {
    return {
      name: t.name, keywords: t.keywords, one_line: t.one_line || '',
      res: t.keywords.map(function (k) { return new RegExp('(^|[^\\p{L}\\p{N}])' + esc(k), 'u'); }),
      ids: [], sum: 0, low: 0
    };
  });
  let unmatched = 0;
  reviews.forEach(function (r) {
    const low = normText(r.text);
    let best = -1, bestHits = 0;
    buckets.forEach(function (b, i) {
      let h = 0; b.res.forEach(function (re) { if (re.test(low)) h++; });
      if (h > bestHits) { bestHits = h; best = i; }
    });
    if (best < 0) { unmatched++; return; }
    const b = buckets[best]; b.ids.push(r.id); b.sum += r.rating; if (r.rating <= 2) b.low++;
  });
  const total = reviews.length || 1;
  return {
    themes: buckets.map(function (b) {
      return {
        name: b.name, keywords: b.keywords, one_line: b.one_line, count: b.ids.length,
        share_pct: round(100 * b.ids.length / total, 1),
        avg_rating: b.ids.length ? round(b.sum / b.ids.length, 2) : 0,
        low_count: b.low,
        low_star_pct: b.ids.length ? round(100 * b.low / b.ids.length, 1) : 0,
        ids: b.ids
      };
    }),
    unmatched: unmatched
  };
}

const DEFAULT_THEMES = [
  { name: 'App speed and reliability', keywords: ['slow', 'lag', 'hang', 'crash', 'glitch', 'bug', 'not working', 'stuck', 'error', 'freez'], one_line: 'Slowness, freezes and failed actions.' },
  { name: 'Support and resolution', keywords: ['support', 'customer care', 'ticket', 'complaint', 'no response', 'resolution', 'helpline'], one_line: 'Support that is slow or does not resolve issues.' },
  { name: 'Charges and fees', keywords: ['charge', 'brokerage', 'fee', 'deduct', 'commission', 'gst', 'hidden'], one_line: 'Deductions users did not expect.' },
  { name: 'Easy to use', keywords: ['easy', 'simple', 'user friendly', 'user-friendly', 'smooth', 'beginner', 'best app', 'good app', 'nice'], one_line: 'Simple, beginner-friendly experience.' },
  { name: 'Money in and out', keywords: ['withdraw', 'refund', 'payment', 'upi', 'bank', 'credited', 'settlement'], one_line: 'Withdrawals, payments and settlement timing.' }
];

// ---------- 4. model output handling ----------
function closeUp(s) {
  let out = '', stack = [], inStr = false, esc2 = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]; out += ch;
    if (inStr) { if (esc2) esc2 = false; else if (ch === '\\') esc2 = true; else if (ch === '"') inStr = false; }
    else if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }
  if (inStr) out += '"';
  out = out.replace(/[,:]\s*$/, '');
  while (stack.length) out += stack.pop() === '{' ? '}' : ']';
  return out;
}
/** Parse model JSON; repairs code fences, trailing commas and truncated output. */
// Some models write their reasoning before the answer. Return the LAST complete,
// parseable top-level {...} object in the text, or undefined.
function lastCompleteObject(s) {
  let found, tail = -1;
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '{') continue;
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end < 0) { tail = i; break; } // an unfinished object: the answer was cut off
    try {
      const v = JSON.parse(s.slice(i, end + 1).replace(/,\s*([}\]])/g, '$1'));
      if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length) { found = v; i = end; }
    } catch (e) { /* not an object, keep scanning */ }
  }
  return { found: tail >= 0 ? undefined : found, tail: tail };
}

function repairJson(raw) {
  let s = String(raw == null ? '' : raw).trim().replace(/^```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  const a = s.indexOf('{');
  if (a < 0) throw new Error('model output has no JSON object');
  const last = lastCompleteObject(s);
  if (last.found !== undefined) return last.found;
  s = s.slice(last.tail >= 0 ? last.tail : a);
  const tryParse = function (t) { try { return JSON.parse(t.replace(/,\s*([}\]])/g, '$1')); } catch (e) { return undefined; } };
  const b = s.lastIndexOf('}');
  if (b >= 0) { const v = tryParse(s.slice(0, b + 1)); if (v !== undefined) return v; }
  let cur = s;
  for (let i = 0; i < 40; i++) {
    const v = tryParse(closeUp(cur));
    if (v !== undefined) return v;
    const c = cur.lastIndexOf(',');
    if (c < 0) break;
    cur = cur.slice(0, c);
  }
  throw new Error('model output is not repairable JSON');
}

function quoteInReview(q, text) {
  const a = normText(q).replace(/^["“”‘’'\s]+|["“”‘’'\s…]+$/g, '').replace(/\.\.\.$/, '').trim();
  return a.length >= 15 && normText(text).includes(a) ? a : null;
}
function clipWords(s, n) { const w = String(s).trim().split(/\s+/); return w.length <= n ? String(s).trim() : w.slice(0, n).join(' ') + ' …'; }

/**
 * Turn the model's proposal into facts. The model supplies theme names and
 * keywords, candidate quotes and wording; counts, ranking and quote checks are code.
 */
function buildInsights(llm, reviews, bank, opts) {
  opts = opts || {};
  llm = llm || {};
  const flags = [];
  const byId = {}; reviews.forEach(function (r) { byId[r.id] = r; });

  // themes: model proposes, code counts across ALL reviews
  let proposed = (Array.isArray(llm.themes) ? llm.themes : []).filter(function (t) {
    return t && t.name && Array.isArray(t.keywords) && t.keywords.filter(Boolean).length >= 2;
  }).slice(0, 5).map(function (t) {
    return { name: String(t.name).slice(0, 60), keywords: t.keywords.map(function (k) { return normText(k); }).filter(Boolean).slice(0, 12), one_line: String(t.one_line || '').slice(0, 120) };
  });
  if (proposed.length < 3) { flags.push('model themes unusable; default taxonomy used'); proposed = DEFAULT_THEMES; }
  const tagged = tagThemes(reviews, proposed);
  // Ranking rule (written before looking at results): most 1-2 star reviews first; ties go to the
  // theme with the higher share of unhappy reviewers, then to the larger theme.
  const ranked = tagged.themes.slice().sort(function (a, b) {
    return (b.low_count - a.low_count) || (b.low_star_pct - a.low_star_pct) || (b.count - a.count);
  });
  const top3 = ranked.slice(0, 3);

  // quotes: model proposes, code verifies verbatim
  const quotes = [], used = new Set();
  (Array.isArray(llm.quotes) ? llm.quotes : []).forEach(function (q) {
    if (!q || quotes.length >= 3) return;
    const r = byId[String(q.review_id)];
    if (!r || used.has(r.id)) return;
    const ok = quoteInReview(q.quote, r.text);
    if (!ok) { flags.push('quote for ' + q.review_id + ' was not verbatim; dropped'); return; }
    const theme = ranked.find(function (t) { return t.ids.indexOf(r.id) >= 0; });
    used.add(r.id);
    quotes.push({ review_id: r.id, date: r.date, rating: r.rating, theme: theme ? theme.name : (q.theme || ''), text: clipWords(String(q.quote).replace(/^["“”\s]+|["“”\s]+$/g, ''), 30) });
  });
  // fill from the top themes with real reviews
  const pools = top3.concat(ranked.slice(3));
  for (let i = 0; i < pools.length && quotes.length < 3; i++) {
    const cands = pools[i].ids.map(function (id) { return byId[id]; }).filter(function (r) {
      return r && !used.has(r.id) && words(r.text) >= 8 && words(r.text) <= 45 && r.text.indexOf('[') < 0;
    }).sort(function (a, b) { return (b.thumbs - a.thumbs) || (a.rating - b.rating); });
    if (cands.length) {
      const r = cands[0]; used.add(r.id);
      quotes.push({ review_id: r.id, date: r.date, rating: r.rating, theme: pools[i].name, text: clipWords(r.text, 30) });
      flags.push('quote ' + r.id + ' chosen by code');
    }
  }

  // fee issue: code ranks, model words it
  const table = feeTable(reviews, Object.keys(bank.entries), (opts.stats || {}).date_to);
  if (!table.length) throw new Error('no charge-related reviews found; cannot identify a fee issue');
  const llmFee = llm.fee_issue || {};
  const chosen = table.find(function (t) { return t.id === llmFee.id; }) || table[0];
  if (llmFee.id && llmFee.id !== chosen.id) flags.push('model fee id not in candidates; top candidate used');
  const entry = bank.entries[chosen.id];
  const allowed = new Set(numbersIn(JSON.stringify({ t: table, s: opts.stats || {} })));
  let summary = String(llmFee.summary || '').trim();
  if (!summary || words(summary) > 45 || !numbersAllowed(summary, allowed)) {
    summary = chosen.confused + ' of ' + chosen.named + ' reviews that mention ' + entry.name.toLowerCase() + ' describe it as unexpected, hidden or unclear.';
    if (llmFee.summary) flags.push('fee summary replaced (length or unverified number)');
  }
  const total = reviews.length;
  // trend: confused mentions per week, last 4 weeks vs the weeks before (needs a real window and enough mentions)
  const weeksTotal = opts.stats && opts.stats.date_from ? Math.max(5, Math.ceil((new Date(opts.stats.date_to) - new Date(opts.stats.date_from)) / (7 * 86400000)) + 1) : 12;
  const recentPw = round(chosen.recent / 4, 1), earlierPw = round(chosen.earlier / Math.max(1, weeksTotal - 4), 1);
  let direction = 'flat';
  if (chosen.confused >= 8) {
    if (recentPw >= earlierPw * 1.25 && recentPw - earlierPw >= 0.3) direction = 'up';
    else if (recentPw <= earlierPw * 0.75 && earlierPw - recentPw >= 0.3) direction = 'down';
  }
  return {
    run_date: opts.runDate || iso(new Date()),
    scope: opts.stats || {},
    themes: tagged.themes.map(function (t) { return { name: t.name, keywords: t.keywords, one_line: t.one_line, count: t.count, share_pct: t.share_pct, avg_rating: t.avg_rating, low_count: t.low_count, low_star_pct: t.low_star_pct }; }),
    unmatched: tagged.unmatched, unmatched_pct: round(100 * tagged.unmatched / (total || 1), 1),
    top_themes: top3.map(function (t) { return { name: t.name, count: t.count, share_pct: t.share_pct, avg_rating: t.avg_rating, low_count: t.low_count, low_star_pct: t.low_star_pct }; }),
    quotes: quotes,
    fee_issue: { id: chosen.id, name: entry.name, named: chosen.named, confused: chosen.confused, confusion_rate_pct: chosen.confusion_rate_pct, summary: summary, trend: { recent_per_week: recentPw, earlier_per_week: earlierPw, direction: direction }, candidates: table.map(function (t) { return { id: t.id, named: t.named, confused: t.confused, confusion_rate_pct: t.confusion_rate_pct }; }), low_sample: chosen.named < 10 },
    flags: flags
  };
}

// ---------- 5. pulse ----------
function pulseObservationFallback(ins) {
  const t = ins.top_themes[0], f = ins.fee_issue, tr = f.trend || {};
  let s = t.name + ' has the most 1-2 star reviews (' + t.low_count + ' of ' + t.count + '). ' +
    f.name + ' is the charge users most often call unexpected: ' + f.confused + ' of ' + f.named + ' reviews naming it say so.';
  if (tr.direction === 'up' || tr.direction === 'down') {
    s += ' Mentions are ' + (tr.direction === 'up' ? 'rising' : 'falling') + ': ' + tr.recent_per_week + ' a week lately against ' + tr.earlier_per_week + ' before.';
  } else if (f.confused < 8) s += ' The sample is small, so no trend is claimed.';
  else s += ' Mentions are steady week on week.';
  return s;
}
function pulseActionsFallback(ins) {
  const f = ins.fee_issue.name.toLowerCase();
  return [
    'Show the full ' + f + ' breakdown, including taxes, on the order confirmation screen.',
    'Link a plain-language ' + f + ' explainer from the charges line and from help search.',
    'Give support the approved explainer as a canned reply and track charge-related contacts weekly.'
  ];
}
function assemblePulse(ins, parts, limit) {
  limit = limit || 250;
  const flags = [];
  const allowed = new Set(numbersIn(JSON.stringify({ ins: ins })));
  let obs = String((parts && parts.observation) || '').trim();
  if (!obs || words(obs) < 12 || words(obs) > 60 || !numbersAllowed(obs, allowed)) {
    if (obs) flags.push('observation replaced (length or unverified number)');
    obs = pulseObservationFallback(ins);
  }
  let acts = (parts && Array.isArray(parts.actions) ? parts.actions : []).map(function (a) { return String(a).trim(); }).filter(Boolean);
  if (acts.length !== 3 || acts.some(function (a) { return words(a) > 26 || !numbersAllowed(a, allowed); })) {
    if (acts.length) flags.push('actions replaced (count, length or unverified number)');
    acts = pulseActionsFallback(ins);
  }
  const s = ins.scope;
  function render(qWords, obsText) {
    const lines = [];
    lines.push('# Weekly product pulse: ' + fmtDate(ins.run_date));
    lines.push('Scope: ' + s.kept + ' reviews, ' + fmtDate(s.date_from) + ' to ' + fmtDate(s.date_to) + '; average ' + s.avg_rating + ' stars.');
    lines.push('');
    lines.push('## Top themes (ranked by 1-2 star reviews)');
    ins.top_themes.forEach(function (t, i) { lines.push((i + 1) + '. ' + t.name + ': ' + t.low_count + ' low-star of ' + t.count + ' reviews (' + t.share_pct + '%), avg ' + t.avg_rating); });
    lines.push('');
    lines.push('## What users said');
    ins.quotes.forEach(function (q) { lines.push('- "' + clipWords(q.text, qWords) + '" (' + q.rating + (q.rating === 1 ? ' star, ' : ' stars, ') + fmtDate(q.date) + ')'); });
    lines.push('');
    lines.push('## Key observation');
    lines.push(obsText);
    lines.push('');
    lines.push('## Actions');
    acts.forEach(function (a, i) { lines.push((i + 1) + '. ' + a); });
    return lines.join('\n');
  }
  let md = render(30, obs);
  const steps = [22, 16, 12];
  for (let i = 0; i < steps.length && words(md) > limit; i++) md = render(steps[i], obs);
  if (words(md) > limit) { obs = pulseObservationFallback(ins); md = render(12, obs); flags.push('observation shortened to fit word limit'); }
  return { markdown: md, words: words(md), flags: flags };
}

// ---------- 6. explainer ----------
function assembleExplainer(feeId, bank, proposedBullets) {
  const entry = bank.entries[feeId];
  if (!entry) throw new Error('no fact-bank entry for ' + feeId);
  const flags = [];
  const bankText = entry.facts.join(' ');
  const allowed = new Set(numbersIn(bankText));
  let bullets = (Array.isArray(proposedBullets) ? proposedBullets : []).map(function (b) { return String(b).trim().replace(/^[-*•\s]+/, ''); }).filter(Boolean);
  const bad = bullets.length < 2 || bullets.length > 6 ||
    bullets.some(function (b) { return words(b) > 45 || BANNED_EXPLAINER.test(b) || !numbersAllowed(b, allowed); });
  if (bad) { if (bullets.length) flags.push('explainer bullets replaced by fact-bank text (limit, tone or unverified number)'); bullets = entry.facts.slice(0, 6); }
  const links = entry.source_keys.slice(0, 2).map(function (k) { return bank.sources[k]; });
  const md = ['## What to know about ' + entry.name.toLowerCase()]
    .concat(bullets.map(function (b) { return '- ' + b; }))
    .concat(['', 'Sources: ' + links.map(function (l) { return '[' + l.title + '](' + l.url + ')'; }).join('; '), 'Last checked: ' + bank.last_checked]).join('\n');
  return { title: entry.name, bullets: bullets, links: links, last_checked: bank.last_checked, markdown: md, flags: flags };
}

// ---------- 7. MCP payload ----------
function buildPayload(ins, pulse, expl) {
  const subject = 'Weekly Product Pulse + Customer Clarification — ' + fmtDate(ins.run_date);
  const body = pulse.markdown + '\n\n---\n\nFee explanation (reusable support snippet)\n\n' + expl.markdown;
  return {
    entry: {
      date: ins.run_date,
      top_themes: ins.top_themes.map(function (t) { return t.name; }),
      weekly_pulse: pulse.markdown,
      identified_fee_issue: ins.fee_issue.name + ': ' + ins.fee_issue.summary,
      explanation_bullets: expl.bullets,
      source_links: expl.links.map(function (l) { return l.url; })
    },
    email: { subject: subject, body: body }
  };
}

/** Plain-text block appended to the Google Doc: exactly the fields the brief lists. */
function buildDocEntry(e) {
  return [
    '=== Weekly product log entry: ' + fmtDate(e.date) + ' ===',
    'date: ' + e.date,
    'top_themes: ' + e.top_themes.join('; '),
    'identified_fee_issue: ' + e.identified_fee_issue,
    'explanation_bullets:',
    e.explanation_bullets.map(function (b) { return '- ' + b; }).join('\n'),
    'source_links: ' + e.source_links.join(' , '),
    'weekly_pulse:',
    e.weekly_pulse,
    '=== end of entry ===',
    ''
  ].join('\n');
}

// ---- exports (stripped when inlined into n8n) ----
if (typeof module !== 'undefined') {
  module.exports = {
    normText, words, round, fmtDate, numbersIn, stripPII, cleanReviews, stratifiedSample, contextLines,
    feeTable, tagThemes, DEFAULT_THEMES, repairJson, quoteInReview, buildInsights, assemblePulse,
    assembleExplainer, buildPayload, buildDocEntry, FEE_TYPES, CONFUSE_RE, BANNED_EXPLAINER
  };
}
