#!/usr/bin/env node
// runner-ollama.mjs — the I/O shell around the gated kernel. Runs an eval set against a CANDIDATE
// and a BASELINE model on a local Ollama, measures for real (latency per probe, temperature 0),
// and writes a tamper-evident receipt. The kernel measures; this only ferries.
//
//   node runner-ollama.mjs evalsets/support-triage.json llama3.2:1b qwen2.5:7b [receipt.json]
//
import { readFileSync, writeFileSync } from 'node:fs';
import { validEvalSet, compare, makeReceipt, verifyReceipt } from './kernel.mjs';

const OLLAMA = process.env.OLLAMA_URL || 'http://localhost:11434';
const [, , evalPath, candModel, baseModel, outPath] = process.argv;
if (!evalPath || !candModel || !baseModel) {
  console.error('usage: node runner-ollama.mjs <evalset.json> <candidateModel> <baselineModel> [receipt.json]');
  process.exit(2);
}

const evalSet = JSON.parse(readFileSync(evalPath, 'utf8'));
const v = validEvalSet(evalSet);
if (!v.ok) { console.error('eval set refused: ' + v.why); process.exit(1); }

async function ask(model, prompt) {
  // streamed: a slow model's first token can be minutes away, and undici's headers timeout
  // kills a non-streaming call at 5 minutes — chunks keep the wire warm instead
  const t0 = Date.now();
  const res = await fetch(OLLAMA + '/api/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: true, options: { temperature: 0, num_predict: 200 } }),
  });
  if (!res.ok) throw new Error(model + ' refused: HTTP ' + res.status);
  let out = '', buf = '';
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try { const j = JSON.parse(line); if (j.response) out += j.response; } catch (e) {}
    }
  }
  return { output: out, ms: Date.now() - t0 };
}

async function runSide(model) {
  const outputs = [], latenciesMs = [];
  for (const [i, p] of evalSet.probes.entries()) {
    const r = await ask(model, evalSet.task + '\n\nMessage:\n' + p.input);
    outputs.push(r.output);
    latenciesMs.push(r.ms);
    process.stdout.write('\r' + model + ': probe ' + (i + 1) + '/' + evalSet.probes.length + ' (' + r.ms + 'ms)   ');
  }
  process.stdout.write('\n');
  return { model, outputs, latenciesMs };
}

console.log('FallForge Gate · ' + evalSet.name + ' · candidate ' + candModel + ' vs baseline ' + baseModel);
const cand = await runSide(candModel);
const base = await runSide(baseModel);

const cmp = compare(evalSet, cand, base);
if (!cmp.ok) { console.error('compare refused: ' + cmp.why); process.exit(1); }
const rec = makeReceipt(cmp, { scoredAt: new Date().toISOString() });
if (!rec.ok) { console.error('receipt refused: ' + rec.why); process.exit(1); }
const check = verifyReceipt(rec.receipt);
if (!check.ok || check.valid !== true) { console.error('receipt failed self-verification — refusing to emit'); process.exit(1); }

const pct = (x) => Math.round(x * 100) + '%';
console.log('');
console.log('VERDICT: ' + cmp.verdict + (cmp.certified ? ' (certified)' : ' (not certified — ' + cmp.why + ')'));
console.log('  candidate ' + cand.model + ': ' + cmp.candidate.passed + '/' + cmp.probes + ' (' + pct(cmp.candidate.passRate) + ') · mean ' + Math.round(cmp.candidate.meanMs) + 'ms');
console.log('  baseline  ' + base.model + ': ' + cmp.baseline.passed + '/' + cmp.probes + ' (' + pct(cmp.baseline.passRate) + ') · mean ' + Math.round(cmp.baseline.meanMs) + 'ms');
console.log('  passDelta ' + (cmp.passDelta >= 0 ? '+' : '') + pct(cmp.passDelta) + ' · speed ' + (Math.round(cmp.speedX * 100) / 100) + 'x');
console.log('  misses (candidate): ' + (cmp.candidate.results.filter((r) => !r.pass).map((r) => r.id).join(', ') || 'none'));
console.log('  misses (baseline):  ' + (cmp.baseline.results.filter((r) => !r.pass).map((r) => r.id).join(', ') || 'none'));

const dest = outPath || 'receipt.json';
writeFileSync(dest, JSON.stringify(rec.receipt, null, 2) + '\n');
console.log('receipt written: ' + dest + ' · hash ' + rec.receipt.hash.slice(0, 16) + '… · self-verified intact');
