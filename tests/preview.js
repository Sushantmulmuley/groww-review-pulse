'use strict';
// Prints what the pipeline produces on the TEST FIXTURE (synthetic, for development only; not submission data).
const fs = require('fs'), path = require('path');
const L = require('../code/lib.js');
const { parseCsv } = require('./helpers.js');
const bank = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/fee_facts.json'), 'utf8'));
const base = parseCsv(fs.readFileSync(path.join(__dirname, 'fixture_reviews.csv'), 'utf8'));
const suffix = ['', ' really', ' honestly', ' today', ' again', ' sadly'];
const rows = []; suffix.forEach((s, k) => base.forEach(r => rows.push({ ...r, review_id: r.review_id + '_' + k, review: r.review ? r.review + s : r.review })));
const { reviews, stats } = L.cleanReviews(rows, { windowWeeks: 12 });
const ins = L.buildInsights({}, reviews, bank, { stats, runDate: '2026-10-17' });
const pulse = L.assemblePulse(ins, {});
const expl = L.assembleExplainer(ins.fee_issue.id, bank, null);
console.log(JSON.stringify(stats), '\n');
console.log(pulse.markdown, '\n[' + pulse.words + ' words]\n');
console.log(expl.markdown, '\n');
console.log('fee candidates:', JSON.stringify(ins.fee_issue.candidates));
console.log('flags:', ins.flags);
