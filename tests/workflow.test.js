'use strict';
// Structural checks on the generated n8n files, plus a simulated run of every Code node
// (n8n's $input / $() / $now stubbed, model replies stubbed). Not a substitute for a real n8n run.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { parseCsv } = require('./helpers.js');

const root = path.join(__dirname, '..');
const mainWf = JSON.parse(fs.readFileSync(path.join(root, 'n8n/review-pulse-main.json'), 'utf8'));
const serverWf = JSON.parse(fs.readFileSync(path.join(root, 'n8n/mcp-server.json'), 'utf8'));

function structural(wf) {
  const names = wf.nodes.map(n => n.name), ids = wf.nodes.map(n => n.id);
  assert.strictEqual(new Set(names).size, names.length, 'node names unique');
  assert.strictEqual(new Set(ids).size, ids.length, 'node ids unique');
  Object.keys(wf.connections).forEach(src => {
    assert.ok(names.includes(src), 'connection source exists: ' + src);
    Object.values(wf.connections[src]).forEach(outs => outs.forEach(list => list.forEach(t => assert.ok(names.includes(t.node), 'connection target exists: ' + t.node))));
  });
  wf.nodes.forEach(n => { assert.ok(Array.isArray(n.position) && n.position.length === 2, n.name); assert.ok(n.type && n.typeVersion, n.name); });
}

test('main workflow: structure is valid', () => structural(mainWf));
test('mcp server workflow: structure is valid', () => structural(serverWf));

test('main workflow: every Code node compiles', () => {
  mainWf.nodes.filter(n => n.type === 'n8n-nodes-base.code').forEach(n => {
    assert.doesNotThrow(() => new Function('$input', '$', '$now', n.parameters.jsCode), n.name);
    assert.ok(!/\brequire\(/.test(n.parameters.jsCode), n.name + ' must not require modules (n8n Cloud)');
    assert.ok(!/module\.exports/.test(n.parameters.jsCode), n.name + ' exports block stripped');
  });
});

test('approval gate: nothing reaches the MCP agent except through the approval node and the IF', () => {
  const into = (target) => Object.entries(mainWf.connections).filter(([, c]) => Object.values(c).some(outs => outs.some(l => l.some(t => t.node === target)))).map(([s]) => s);
  assert.deepStrictEqual(into('Build MCP instructions'), ['Approved?']);
  assert.deepStrictEqual(into('Approved?'), ['Ask for approval']);
  assert.deepStrictEqual(into('AI Agent (MCP)'), ['Build MCP instructions', 'Gemini model (agent)', 'MCP Client']);
  const ap = mainWf.nodes.find(n => n.name === 'Ask for approval');
  assert.strictEqual(ap.parameters.operation, 'sendAndWait');
  assert.strictEqual(ap.parameters.responseType, 'approval');
  assert.ok(ap.webhookId);
  // the IF's false branch goes to Rejected, which has no outgoing connections
  assert.strictEqual(mainWf.connections['Approved?'].main[1][0].node, 'Rejected');
  assert.strictEqual(mainWf.connections['Rejected'], undefined);
});

test('mcp server: exactly the two tools from the brief, draft only, no send', () => {
  const tools = serverWf.nodes.filter(n => n.type.endsWith('Tool')).map(n => n.name).sort();
  assert.deepStrictEqual(tools, ['append_to_doc', 'create_email_draft']);
  const gm = serverWf.nodes.find(n => n.name === 'create_email_draft');
  assert.strictEqual(gm.parameters.resource, 'draft');
  assert.strictEqual(gm.parameters.operation, 'create');
  assert.ok(serverWf.nodes.every(n => !(n.parameters && /send(?!To)/i.test(String(n.parameters.operation || '')))), 'no send operation anywhere');
  Object.keys(serverWf.connections).forEach(k => assert.ok(serverWf.connections[k].ai_tool[0][0].node === 'MCP Server Trigger'));
});

test('simulated n8n run of the four Code nodes with stubbed model replies', () => {
  const bank = JSON.parse(fs.readFileSync(path.join(root, 'data/fee_facts.json'), 'utf8'));
  const base = parseCsv(fs.readFileSync(path.join(__dirname, 'fixture_reviews.csv'), 'utf8'));
  const suffix = ['', ' really', ' honestly', ' today', ' again', ' sadly'];
  const rows = [];
  suffix.forEach((s, k) => base.forEach(r => rows.push(Object.assign({}, r, { review_id: r.review_id + '_' + k, review: r.review ? r.review + s : r.review }))));
  const code = n => mainWf.nodes.find(x => x.name === n).parameters.jsCode;
  const run = (name, input, refs) => {
    const $ = nm => ({ first: () => ({ json: refs[nm] }) });
    const $input = { all: () => input.map(j => ({ json: j })), first: () => ({ json: input[0] }) };
    const $now = { toISODate: () => '2026-10-17' };
    return new Function('$input', '$', '$now', code(name))($input, $, $now)[0].json;
  };
  const refs = { Config: { windowWeeks: 12, sampleSize: 40, approverEmail: 'me@example.com', draftTo: 'team@example.com' } };

  refs['Clean and retrieve'] = run('Clean and retrieve', rows, refs);
  assert.ok(refs['Clean and retrieve'].prompt.includes('FEE CANDIDATES'));
  assert.ok(refs['Clean and retrieve'].prompt.includes('SAMPLE ('));
  assert.ok(!/9876543210|ABCDE1234F/.test(refs['Clean and retrieve'].prompt), 'no PII reaches the model');

  const llm1 = '```json\n' + JSON.stringify({
    themes: [
      { name: 'Charges users did not expect', keywords: ['brokerage', 'charge', 'deduct', 'gst', 'hidden'] },
      { name: 'App speed and crashes', keywords: ['slow', 'lag', 'hang', 'crash', 'glitch', 'freez'] },
      { name: 'Support that does not resolve', keywords: ['support', 'ticket', 'complaint'] },
      { name: 'Easy to use', keywords: ['easy', 'simple', 'smooth', 'beginner'] },
      { name: 'Money in and out', keywords: ['withdraw', 'refund', 'upi'] }
    ],
    quotes: [{ review_id: 't01_0', quote: 'They deducted brokerage and extra charges I never knew about when I sold my shares' }],
    fee_issue: { id: 'brokerage', summary: 'Users do not expect brokerage plus other deductions on one sale.' }
  }) + '\n```';
  refs['Check insights'] = run('Check insights', [{ text: llm1 }], refs);
  const ins = refs['Check insights'].insights;
  assert.strictEqual(ins.top_themes.length, 3);
  assert.strictEqual(ins.quotes.length, 3);
  assert.ok(refs['Check insights'].prompt2.includes('FACTS about'));

  const feeFacts = bank.entries[ins.fee_issue.id].facts;
  const llm2 = JSON.stringify({
    observation: 'Charges are the most fixable problem this week, and the same deduction question keeps reaching support with different answers each time.',
    actions: ['Show the full charge breakdown at order confirmation.', 'Link one plain-language charges explainer from the order screen.', 'Give support one approved reply and track repeat contacts.'],
    explainer_bullets: feeFacts.slice(0, 4)
  });
  refs['Check outputs'] = run('Check outputs', [{ text: llm2 }], refs);
  const out = refs['Check outputs'];
  assert.ok(out.pulse_words <= 250);
  assert.ok(out.approval_text.includes('WEEKLY PULSE') && out.approval_text.includes('FEE EXPLAINER'));
  assert.ok(out.doc_entry.includes('source_links:'));
  assert.strictEqual(out.payload.entry.source_links.length, 2);

  const mcp = run('Build MCP instructions', [{}], refs);
  assert.ok(mcp.prompt.includes('<<<DOC ENTRY') && mcp.prompt.includes('<<<EMAIL BODY'));
  assert.ok(mcp.prompt.includes('team@example.com'));
  assert.ok(mcp.prompt.includes('Weekly Product Pulse + Customer Clarification — 17 Oct 2026'));
});

test('simulated run survives a model that returns garbage', () => {
  const base = parseCsv(fs.readFileSync(path.join(__dirname, 'fixture_reviews.csv'), 'utf8'));
  const suffix = ['', ' really', ' honestly', ' today', ' again', ' sadly'];
  const rows = [];
  suffix.forEach((s, k) => base.forEach(r => rows.push(Object.assign({}, r, { review_id: r.review_id + '_' + k, review: r.review ? r.review + s : r.review }))));
  const code = n => mainWf.nodes.find(x => x.name === n).parameters.jsCode;
  const refs = { Config: { windowWeeks: 12, sampleSize: 40, approverEmail: 'a@b.c', draftTo: 'd@e.f' } };
  const run = (name, input) => {
    const $ = nm => ({ first: () => ({ json: refs[nm] }) });
    return new Function('$input', '$', '$now', code(name))({ all: () => input.map(j => ({ json: j })), first: () => ({ json: input[0] }) }, $, { toISODate: () => '2026-10-17' })[0].json;
  };
  refs['Clean and retrieve'] = run('Clean and retrieve', rows);
  refs['Check insights'] = run('Check insights', [{ text: 'Sorry, I cannot help with that.' }]);
  assert.ok(refs['Check insights'].insights.flags.some(f => /unreadable/.test(f)));
  refs['Check outputs'] = run('Check outputs', [{ text: '<html>oops</html>' }]);
  assert.ok(refs['Check outputs'].pulse_words <= 250);
  assert.ok(refs['Check outputs'].flags.some(f => /unreadable/.test(f)));
  assert.strictEqual(refs['Check outputs'].payload.entry.explanation_bullets.length > 0, true);
});
