'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const L = require('../code/lib.js');
const { parseCsv } = require('./helpers.js');

const rows = parseCsv(fs.readFileSync(path.join(__dirname, 'fixture_reviews.csv'), 'utf8'));
const bank = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/fee_facts.json'), 'utf8'));
const { reviews, stats } = L.cleanReviews(rows, { windowWeeks: 12 });

// A stand-in for the model's first answer. Deliberately includes bad quotes and a made-up number.
const LLM_THEMES = {
  themes: [
    { name: 'Charges users did not expect', keywords: ['brokerage', 'charge', 'deduct', 'gst', 'hidden', 'fee'], one_line: 'Deductions on trades.' },
    { name: 'App speed and crashes', keywords: ['slow', 'lag', 'hang', 'crash', 'glitch', 'freez', 'bug'], one_line: 'Freezes and failed orders.' },
    { name: 'Support that does not resolve', keywords: ['support', 'ticket', 'complaint', 'resolution'], one_line: 'No replies.' },
    { name: 'Easy to use', keywords: ['easy', 'simple', 'smooth', 'beginner', 'user friendly'], one_line: 'Simple for beginners.' },
    { name: 'Money in and out', keywords: ['withdraw', 'refund', 'upi', 'credited'], one_line: 'Payments.' }
  ],
  quotes: [
    { review_id: 't01', quote: 'They deducted brokerage and extra charges I never knew about when I sold my shares' },
    { review_id: 't02', quote: 'a quote the user never wrote at all, invented by the model' },
    { review_id: 't05', quote: 'Customer support never replies to my ticket' }
  ],
  fee_issue: { id: 'brokerage', summary: 'Users say the deduction was 4521 times higher than expected.' }
};

test('clean: drops bad rows, duplicates, short reviews, out-of-window rows', () => {
  assert.strictEqual(stats.rows_in, 45);
  assert.strictEqual(stats.dropped_bad_row, 2);        // t40 bad rating, t41 empty text
  assert.strictEqual(stats.dropped_duplicate, 1);      // t32 repeats t04
  assert.strictEqual(stats.dropped_short, 1);          // t31 "Good"
  assert.ok(stats.dropped_outside_window >= 1);        // t39 (July)
  assert.ok(!reviews.some(r => r.id === 't39'));
  assert.strictEqual(stats.kept, reviews.length);
});

test('clean: personal data is redacted before anything is shown or sent to a model', () => {
  const all = reviews.map(r => r.text).join('\n');
  assert.ok(!/9876543210/.test(all));
  assert.ok(!/ABCDE1234F/.test(all));
  assert.ok(!/someone@example\.com/.test(all));
  assert.strictEqual(stats.pii_redacted, 2); // reviews t22 (phone + PAN) and t28 (email)
});

test('stats are internally consistent', () => {
  const avg = reviews.reduce((a, r) => a + r.rating, 0) / reviews.length;
  assert.ok(Math.abs(stats.avg_rating - avg) < 0.01);
  assert.ok(stats.date_from <= stats.date_to);
});

test('fee table counts each review once and ranks by confusion', () => {
  const t = L.feeTable(reviews, Object.keys(bank.entries));
  const named = t.reduce((a, r) => a + r.named, 0);
  assert.ok(named <= reviews.length);
  for (let i = 1; i < t.length; i++) assert.ok(t[i - 1].confused >= t[i].confused);
  assert.ok(t.every(r => r.confused <= r.named));
});

test('insights: counts come from code, not from the model', () => {
  const ins = L.buildInsights(LLM_THEMES, reviews, bank, { stats, runDate: '2026-10-17' });
  assert.strictEqual(ins.themes.length, 5);
  const matched = ins.themes.reduce((a, t) => a + t.count, 0);
  assert.strictEqual(matched + ins.unmatched, reviews.length);
  assert.strictEqual(ins.top_themes.length, 3);
  for (let i = 1; i < ins.top_themes.length; i++) assert.ok(ins.top_themes[i - 1].count >= ins.top_themes[i].count);
});

test('quotes: every quote is verbatim from a real review; invented ones are dropped and replaced', () => {
  const ins = L.buildInsights(LLM_THEMES, reviews, bank, { stats });
  assert.strictEqual(ins.quotes.length, 3);
  ins.quotes.forEach(q => {
    const r = reviews.find(x => x.id === q.review_id);
    assert.ok(r, 'quote must point at a real review');
    const core = q.text.replace(/ …$/, '');
    assert.ok(L.normText(r.text).includes(L.normText(core)), 'quote must be a verbatim excerpt: ' + q.text);
  });
  assert.ok(!ins.quotes.some(q => q.review_id === 't02'));
  assert.ok(ins.flags.some(f => /not verbatim/.test(f)));
});

test('fee issue: model cannot invent numbers; summary falls back to counted figures', () => {
  const ins = L.buildInsights(LLM_THEMES, reviews, bank, { stats });
  assert.ok(!/4521/.test(ins.fee_issue.summary));
  assert.ok(ins.fee_issue.confused <= ins.fee_issue.named);
  assert.ok(ins.flags.some(f => /fee summary replaced/.test(f)));
});

test('fee issue: unknown id from the model falls back to the top candidate', () => {
  const ins = L.buildInsights({ ...LLM_THEMES, fee_issue: { id: 'made_up' } }, reviews, bank, { stats });
  assert.strictEqual(ins.fee_issue.id, ins.fee_issue.candidates[0].id);
});

test('unusable model themes fall back to the default taxonomy and say so', () => {
  const ins = L.buildInsights({ themes: [{ name: 'x', keywords: ['a'] }] }, reviews, bank, { stats });
  assert.ok(ins.flags.some(f => /default taxonomy/.test(f)));
  assert.ok(ins.themes.length <= 5);
});

test('pulse: at most 250 words, three actions, three quotes, verified numbers only', () => {
  const ins = L.buildInsights(LLM_THEMES, reviews, bank, { stats, runDate: '2026-10-17' });
  const p = L.assemblePulse(ins, { observation: 'Charges drove 9999 complaints this week and everything is on fire across the whole product experience for users.', actions: ['a', 'b'] });
  assert.ok(p.words <= 250, 'words=' + p.words);
  assert.ok(!/9999/.test(p.markdown));
  assert.strictEqual((p.markdown.match(/^\d\. /gm) || []).length, 3 + 3); // 3 themes + 3 actions
  assert.strictEqual((p.markdown.match(/^- "/gm) || []).length, 3);
  assert.ok(p.flags.length >= 2);
});

test('pulse: a long model answer is trimmed to the limit, not rejected silently', () => {
  const ins = L.buildInsights(LLM_THEMES, reviews, bank, { stats, runDate: '2026-10-17' });
  const long = 'Charges are the most fixable problem because ' + 'users keep asking the same question about deductions and support answers differently each time. '.repeat(2);
  const p = L.assemblePulse(ins, { observation: long.trim(), actions: ['Show the charge breakdown at order confirmation.', 'Link an explainer from the charges line.', 'Give support one approved reply.'] }, 120);
  assert.ok(p.words <= 120 || p.flags.length > 0);
});

test('explainer: at most 6 bullets, exactly 2 source links, Last checked present', () => {
  for (const id of Object.keys(bank.entries)) {
    const e = L.assembleExplainer(id, bank, null);
    assert.ok(e.bullets.length >= 2 && e.bullets.length <= 6, id);
    assert.strictEqual(e.links.length, 2, id);
    assert.ok(/Last checked: \d/.test(e.markdown), id);
    assert.ok(e.links.every(l => /^https:\/\/groww\.in\//.test(l.url)), id);
  }
});

test('explainer: fact bank itself passes the neutral-tone check', () => {
  for (const [id, e] of Object.entries(bank.entries)) {
    e.facts.forEach(f => assert.ok(!L.BANNED_EXPLAINER.test(f), id + ': ' + f));
  }
});

test('explainer: model bullets with a made-up rate or advice words are rejected', () => {
  const e1 = L.assembleExplainer('brokerage', bank, ['Brokerage is ₹25 per order.', 'GST applies.']);
  assert.ok(e1.flags.length === 1);
  const e2 = L.assembleExplainer('brokerage', bank, ['You should avoid trading often to save on brokerage.', 'GST of 18% applies on brokerage.']);
  assert.ok(e2.flags.length === 1);
  const ok = L.assembleExplainer('brokerage', bank, ['Brokerage is ₹20 or 0.1% of the order value, whichever is lower.', 'A minimum of ₹5 applies per executed order.', '18% GST applies on brokerage.']);
  assert.strictEqual(ok.flags.length, 0);
  assert.strictEqual(ok.bullets.length, 3);
});

test('payload matches the brief: required fields, subject format, email body has pulse and explainer', () => {
  const ins = L.buildInsights(LLM_THEMES, reviews, bank, { stats, runDate: '2026-10-17' });
  const p = L.assemblePulse(ins, {});
  const e = L.assembleExplainer(ins.fee_issue.id, bank, null);
  const out = L.buildPayload(ins, p, e);
  ['date', 'top_themes', 'weekly_pulse', 'identified_fee_issue', 'explanation_bullets', 'source_links'].forEach(k => assert.ok(k in out.entry, k));
  assert.ok(/^Weekly Product Pulse \+ Customer Clarification — 17 Oct 2026$/.test(out.email.subject));
  assert.ok(out.email.body.includes('Weekly product pulse'));
  assert.ok(out.email.body.includes('Last checked'));
  assert.strictEqual(out.entry.source_links.length, 2);
});

test('repairJson handles code fences, trailing commas and truncated output', () => {
  assert.deepStrictEqual(L.repairJson('```json\n{"a":1,}\n```'), { a: 1 });
  const cut = L.repairJson('{"themes":[{"name":"A","keywords":["x","y"]},{"name":"B","keywords":["z","w"]},{"name":"C","keyw');
  assert.strictEqual(cut.themes.length >= 2, true);
  assert.throws(() => L.repairJson('no json here'));
});

test('stratified sample is deterministic and keeps a negative-heavy mix', () => {
  const a = L.stratifiedSample(reviews, 20, 17), b = L.stratifiedSample(reviews, 20, 17);
  assert.deepStrictEqual(a.map(r => r.id), b.map(r => r.id));
  assert.strictEqual(a.length, 20);
  assert.ok(a.filter(r => r.rating <= 2).length >= 8);
});

test('fee trend is reported only with enough mentions, and uses counted figures', () => {
  const ins = L.buildInsights(LLM_THEMES, reviews, bank, { stats, runDate: '2026-10-17' });
  const tr = ins.fee_issue.trend;
  assert.ok(['up', 'down', 'flat'].includes(tr.direction));
  assert.ok(tr.recent_per_week >= 0 && tr.earlier_per_week >= 0);
  if (ins.fee_issue.confused < 8) assert.strictEqual(tr.direction, 'flat');
  const p = L.assemblePulse(ins, {});
  assert.ok(/Mentions are|sample is small/.test(p.markdown));
});

test('doc entry contains every field the brief lists', () => {
  const ins = L.buildInsights(LLM_THEMES, reviews, bank, { stats, runDate: '2026-10-17' });
  const p = L.assemblePulse(ins, {});
  const e = L.assembleExplainer(ins.fee_issue.id, bank, null);
  const doc = L.buildDocEntry(L.buildPayload(ins, p, e).entry);
  ['date:', 'top_themes:', 'identified_fee_issue:', 'explanation_bullets:', 'source_links:', 'weekly_pulse:'].forEach(k => assert.ok(doc.includes(k), k));
});
