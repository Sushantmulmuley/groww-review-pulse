'use strict';
// The page and the repo must reproduce the real n8n run exactly: same CSV + same model replies => same Doc entry.
const test = require('node:test'); const assert = require('node:assert'); const fs = require('fs'); const path = require('path');
const L = require('../code/lib.js'); const { parseCsv } = require('./helpers.js');
const root = path.join(__dirname, '..');
test('recomputed Doc entry equals the entry n8n wrote on 21 Oct 2026', () => {
  const c = L.cleanReviews(parseCsv(fs.readFileSync(path.join(root, 'docs/data/reviews.csv'), 'utf8')), { windowWeeks: 12 });
  const bank = JSON.parse(fs.readFileSync(path.join(root, 'docs/data/fee_facts.json'), 'utf8'));
  const s = JSON.parse(fs.readFileSync(path.join(root, 'docs/data/snapshot.json'), 'utf8'));
  const ins = L.buildInsights(s.llm1, c.reviews, bank, { stats: c.stats, runDate: s.run_date });
  const p = L.assemblePulse(ins, { observation: s.llm2.observation, actions: s.llm2.actions });
  const x = L.assembleExplainer(ins.fee_issue.id, bank, s.llm2.explainer_bullets);
  assert.deepStrictEqual([ins.flags, p.flags, x.flags], [[], [], []]);
  const entry = L.buildDocEntry(L.buildPayload(ins, p, x).entry);
  assert.strictEqual(entry.trim(), fs.readFileSync(path.join(root, 'outputs/run_2026-10-21/doc_entry.txt'), 'utf8').trim());
});
