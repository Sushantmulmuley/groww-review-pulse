'use strict';
/*
 * Runs the same checks and builders as the n8n Code nodes on a reviews CSV, with NO model call.
 * Themes come from the default taxonomy and the pulse text from the code-built fallback,
 * so this is the "floor" the workflow falls back to when Gemini fails. Use it to
 * sanity-check a CSV before running n8n:   node run_local.js data/reviews.csv
 * Writes outputs/local_*.
 */
const fs = require('fs'), path = require('path');
const L = require('./code/lib.js');
const { parseCsv } = require('./tests/helpers.js');
const file = process.argv[2] || 'data/reviews.csv';
const bank = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/fee_facts.json'), 'utf8'));
const rows = parseCsv(fs.readFileSync(file, 'utf8'));
const { reviews, stats } = L.cleanReviews(rows, { windowWeeks: 12 });
if (reviews.length < 50) { console.error('Only ' + reviews.length + ' usable reviews; need at least 50.'); process.exit(1); }
const ins = L.buildInsights({}, reviews, bank, { stats: stats, runDate: new Date().toISOString().slice(0, 10) });
const pulse = L.assemblePulse(ins, {});
const expl = L.assembleExplainer(ins.fee_issue.id, bank, null);
const payload = L.buildPayload(ins, pulse, expl);
fs.mkdirSync(path.join(__dirname, 'outputs'), { recursive: true });
const out = (n, t) => fs.writeFileSync(path.join(__dirname, 'outputs', n), t);
out('local_insights.json', JSON.stringify(ins, null, 2));
out('local_weekly_pulse.md', pulse.markdown + '\n');
out('local_fee_explainer.md', expl.markdown + '\n');
out('local_doc_entry.txt', L.buildDocEntry(payload.entry));
out('local_email_draft.txt', 'Subject: ' + payload.email.subject + '\n\n' + payload.email.body + '\n');
console.log(JSON.stringify(stats));
console.log('top themes (default taxonomy):', ins.top_themes.map(function (t) { return t.name + ' ' + t.count; }).join(' | '));
console.log('fee candidates:', ins.fee_issue.candidates.map(function (c) { return c.id + ' ' + c.confused + '/' + c.named; }).join(' | '));
console.log('pulse words:', pulse.words, '| explainer bullets:', expl.bullets.length);
console.log('wrote outputs/local_*');
