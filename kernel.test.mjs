import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_PROBES, SCORER_TYPES, sha256, canon,
  validEvalSet, scoreProbe, scoreRun, compare, makeReceipt, verifyReceipt,
} from './kernel.mjs';

// ── sha256 + canon: pinned to the standards
test('sha256: FIPS vectors pin every constant and operator', () => {
  assert.equal(sha256('').hash, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256('abc').hash, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq').hash,
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  assert.equal(sha256(5).ok, false);
});

test('canon: key order never changes the hash; primitives are distinct', () => {
  assert.equal(canon({ b: 1, a: 2 }), canon({ a: 2, b: 1 }));
  assert.notEqual(canon({ x: 5 }), canon({ x: '5' }));
  assert.notEqual(canon({ x: true }), canon({ x: false }));
  assert.notEqual(canon({ x: null }), canon({ x: 0 }));
});

// ── a small real eval set used across the suite
const ES = {
  name: 'triage-mini', task: 'extract fields from a support message',
  probes: [
    { id: 'p1', input: 'in1', expect: { type: 'exact', value: 'Refund' } },
    { id: 'p2', input: 'in2', expect: { type: 'contains', all: ['urgent', 'order 41'] } },
    { id: 'p3', input: 'in3', expect: { type: 'number', value: 42, tolerance: 0.5 } },
    { id: 'p4', input: 'in4', expect: { type: 'json-field', field: 'customer.email', value: 'a@b.co' } },
    { id: 'p5', input: 'in5', expect: { type: 'exact', value: 'yes', caseSensitive: true } },
    { id: 'p6', input: 'in6', expect: { type: 'exact', value: 'no' } },
    { id: 'p7', input: 'in7', expect: { type: 'contains', all: ['ok'] } },
    { id: 'p8', input: 'in8', expect: { type: 'number', value: -3.5, tolerance: 0 } },
    { id: 'p9', input: 'in9', expect: { type: 'json-field', field: 'urgency', value: 'high' } },
    { id: 'p10', input: 'in10', expect: { type: 'exact', value: 'Done' } },
  ],
};
const PASSING = ['refund', 'URGENT about Order 41!', 'the answer is 42.3', 'sure: {"customer":{"email":"A@b.co"}}',
  'yes', 'NO', 'all ok here', 'change of -3.5 today', '{"urgency":"high","x":1}', ' done '];

test('validEvalSet: a good set passes; each guard refuses with its own why', () => {
  assert.equal(validEvalSet(ES).ok, true);
  assert.equal(validEvalSet(ES).probes, 10);
  assert.equal(validEvalSet(null).ok, false);
  assert.equal(validEvalSet({ ...ES, name: '' }).ok, false);            // isolates length === 0
  assert.equal(validEvalSet({ ...ES, name: 7 }).ok, false);             // isolates isStr
  assert.equal(validEvalSet({ ...ES, task: '' }).ok, false);
  assert.equal(validEvalSet({ ...ES, probes: [] }).ok, false);
  assert.equal(validEvalSet({ ...ES, probes: 'x' }).ok, false);
  const dup = { ...ES, probes: [ES.probes[0], ES.probes[0]] };
  assert.match(validEvalSet(dup).why, /duplicate probe id/);
  const noInput = { ...ES, probes: [{ id: 'q', input: '', expect: { type: 'exact', value: 'x' } }] };
  assert.equal(validEvalSet(noInput).ok, false);
  const badType = { ...ES, probes: [{ id: 'q', input: 'i', expect: { type: 'judge', value: 'x' } }] };
  assert.match(validEvalSet(badType).why, /unknown scorer type/);
});

test('validEvalSet: every scorer shape refuses malformed expects with the TRUE reason', () => {
  const mk = (expect) => validEvalSet({ name: 'n', task: 't', probes: [{ id: 'q', input: 'i', expect }] });
  assert.match(mk({ type: 'exact', value: 7 }).why, /exact expects a string/);
  assert.match(mk({ type: 'contains', all: [] }).why, /non-empty array/);
  assert.match(mk({ type: 'contains', all: ['a', ''] }).why, /non-empty string/);
  assert.match(mk({ type: 'contains', all: ['a', 7] }).why, /non-empty string/);
  assert.match(mk({ type: 'number', value: 'x', tolerance: 1 }).why, /numeric value/);
  assert.match(mk({ type: 'number', value: 1, tolerance: -1 }).why, /non-negative tolerance/);
  assert.equal(mk({ type: 'number', value: 1, tolerance: 0 }).ok, true);   // zero tolerance is VALID (kills < vs <=)
  assert.match(mk({ type: 'json-field', field: '', value: 'x' }).why, /field path/);
  assert.match(mk({ type: 'json-field', field: 'f', value: null }).why, /string, number or boolean/);
  assert.equal(mk({ type: 'json-field', field: 'f', value: false }).ok, true);
  assert.equal(mk({ type: 'json-field', field: 'f', value: 0 }).ok, true);
});

// ── the scorers
test('scoreProbe exact: normalization, case rules, and misses', () => {
  const p = (expect, out) => scoreProbe({ id: 'x', input: 'i', expect }, out);
  assert.equal(p({ type: 'exact', value: 'Refund' }, '  refund  ').pass, true);
  assert.equal(p({ type: 'exact', value: 'Refund' }, 'refunds').pass, false);
  assert.equal(p({ type: 'exact', value: 'a  b' }, 'a b').pass, true);          // whitespace collapses
  assert.equal(p({ type: 'exact', value: 'yes', caseSensitive: true }, 'Yes').pass, false);
  assert.equal(p({ type: 'exact', value: 'yes', caseSensitive: true }, 'yes').pass, true);
  assert.equal(p({ type: 'exact', value: 'x' }, 12).pass, false);               // non-string output = fail, not throw
  assert.match(p({ type: 'exact', value: 'x' }, 12).why, /no output/);
});

test('scoreProbe contains: ALL terms required — one missing fails with its name', () => {
  const p = (out) => scoreProbe({ id: 'x', input: 'i', expect: { type: 'contains', all: ['urgent', 'order 41'] } }, out);
  assert.equal(p('URGENT: Order 41 broke').pass, true);
  assert.equal(p('urgent only').pass, false);
  assert.match(p('urgent only').why, /order 41/);
  assert.equal(p('order 41 but calm').pass, false);
});

test('scoreProbe number: first number, comma-blind, exact tolerance boundary', () => {
  const p = (expect, out) => scoreProbe({ id: 'x', input: 'i', expect }, out);
  assert.equal(p({ type: 'number', value: 42, tolerance: 0.5 }, 'roughly 42.5 units').pass, true);   // AT tolerance — passes (kills <= vs <)
  assert.equal(p({ type: 'number', value: 42, tolerance: 0.5 }, 'roughly 42.51 units').pass, false); // one past — fails
  assert.equal(p({ type: 'number', value: 1000, tolerance: 0 }, 'total: 1,000').pass, true);         // comma-blind
  assert.equal(p({ type: 'number', value: -3.5, tolerance: 0 }, 'delta -3.5 today').pass, true);     // negative + zero tolerance
  assert.equal(p({ type: 'number', value: 5, tolerance: 1 }, 'no digits here').pass, false);
});

test('scoreProbe json-field: finds the first balanced object in prose, walks dot paths', () => {
  const p = (expect, out) => scoreProbe({ id: 'x', input: 'i', expect }, out);
  const e = { type: 'json-field', field: 'customer.email', value: 'a@b.co' };
  assert.equal(p(e, 'Sure! Here you go: {"customer":{"email":"A@B.co"},"z":"{not json}"} hope that helps').pass, true);
  assert.equal(p(e, '```json\n{"customer":{"email":"a@b.co"}}\n```').pass, true);
  assert.equal(p(e, '{"customer":{"mail":"a@b.co"}}').pass, false);
  assert.equal(p(e, 'no json at all').pass, false);
  assert.equal(p(e, '{"customer": {"email": "a@b.co"').pass, false);            // unbalanced — refused as not found
  assert.equal(p({ type: 'json-field', field: 'n', value: 3 }, '{"n":3}').pass, true);
  assert.equal(p({ type: 'json-field', field: 'n', value: 3 }, '{"n":"3"}').pass, false);  // type-strict for non-strings
  assert.equal(p({ type: 'json-field', field: 'ok', value: true }, '{"ok":true}').pass, true);
  assert.equal(p({ type: 'json-field', field: 's', value: 'High' }, '{"s":" high "}').pass, true);   // strings normalize
});

// ── run scoring
test('scoreRun: exact accounting, order preserved, length must match', () => {
  const r = scoreRun(ES, PASSING);
  assert.equal(r.ok, true);
  assert.equal(r.passed, 10);
  assert.equal(r.passRate, 1);
  const oneMiss = [...PASSING]; oneMiss[5] = 'maybe';
  const r2 = scoreRun(ES, oneMiss);
  assert.equal(r2.passed, 9);
  assert.equal(r2.passRate, 0.9);
  assert.equal(r2.results[5].pass, false);
  assert.equal(r2.results[5].id, 'p6');
  assert.equal(scoreRun(ES, PASSING.slice(0, 9)).ok, false);   // length mismatch
  assert.equal(scoreRun(ES, 'x').ok, false);
});

// ── the comparison and its verdicts
const side = (model, outputs, ms) => ({ model, outputs, latenciesMs: outputs.map(() => ms) });

test('compare: BEATS, LOSES and MATCHES land exactly on the pass-rate boundary', () => {
  const twoMiss = [...PASSING]; twoMiss[0] = 'wrong'; twoMiss[1] = 'wrong';
  const oneMiss = [...PASSING]; oneMiss[0] = 'wrong';
  const beats = compare(ES, side('little', oneMiss, 100), side('big', twoMiss, 400));
  assert.equal(beats.verdict, 'BEATS');
  assert.equal(beats.certified, true);
  assert.equal(beats.passDelta, 0.1);
  assert.equal(beats.speedX, 4);
  const loses = compare(ES, side('little', twoMiss, 100), side('big', oneMiss, 400));
  assert.equal(loses.verdict, 'LOSES');
  assert.equal(loses.certified, false);
  const matches = compare(ES, side('little', oneMiss, 100), side('big', [...oneMiss], 400));
  assert.equal(matches.verdict, 'MATCHES');
  assert.equal(matches.certified, false);              // equal is NOT strictly better (kills > vs >=)
  assert.match(matches.why, /did not strictly beat/);
});

test('compare: refusals — same model, malformed sides, probe-count evidence floor', () => {
  assert.match(compare(ES, side('m', PASSING, 1), side('m', PASSING, 1)).why, /same model/);
  assert.equal(compare(ES, side('', PASSING, 1), side('b', PASSING, 1)).ok, false);
  assert.equal(compare(ES, { model: 'a', outputs: PASSING, latenciesMs: [1] }, side('b', PASSING, 1)).ok, false);  // latency length
  assert.equal(compare(ES, { model: 'a', outputs: PASSING, latenciesMs: PASSING.map(() => -1) }, side('b', PASSING, 1)).ok, false);
  assert.equal(compare(ES, { model: 'a', outputs: PASSING, latenciesMs: PASSING.map(() => '1') }, side('b', PASSING, 1)).ok, false);
  assert.equal(compare(null, side('a', [], 1), side('b', [], 1)).ok, false);
  // exactly MIN_PROBES certifies; one fewer never does — even on a win (kills >= vs >)
  const nine = { name: 'n', task: 't', probes: ES.probes.slice(0, 9) };
  const nineWin = compare(nine, side('little', PASSING.slice(0, 9), 1), side('big', ['x', ...PASSING.slice(1, 9)], 1));
  assert.equal(nineWin.verdict, 'BEATS');
  assert.equal(nineWin.certified, false);
  assert.match(nineWin.why, new RegExp('fewer than ' + MIN_PROBES));
  assert.equal(MIN_PROBES, 10);                        // the constant itself is pinned
  assert.deepEqual([...SCORER_TYPES], ['exact', 'contains', 'number', 'json-field']);
});

test('compare: zero candidate latency cannot divide — speedX 0, never Infinity', () => {
  const r = compare(ES, side('a', PASSING, 0), side('b', PASSING, 400));
  assert.equal(r.speedX, 0);
});

// ── receipts
test('receipt: made from measured facts, verifies intact, any tamper shows', () => {
  const oneMiss = [...PASSING]; oneMiss[0] = 'wrong';
  const cmp = compare(ES, side('little', PASSING, 120), side('big', oneMiss, 480));
  const r = makeReceipt(cmp, { scoredAt: '2026-09-14T12:00:00Z' });
  assert.equal(r.ok, true);
  assert.equal(r.receipt.verdict, 'BEATS');
  assert.equal(r.receipt.certified, true);
  assert.equal(r.receipt.speedX, 4);
  assert.match(r.receipt.scope, /never a general claim/);
  assert.equal(verifyReceipt(r.receipt).valid, true);
  assert.equal(verifyReceipt({ ...r.receipt, verdict: 'LOSES' }).valid, false);          // flipped verdict shows
  assert.equal(verifyReceipt({ ...r.receipt, passDelta: 0.9 }).valid, false);            // inflated margin shows
  assert.equal(verifyReceipt({ ...r.receipt, baseline: { ...r.receipt.baseline, passRate: 0.2 } }).valid, false);  // sandbagged baseline shows
  assert.equal(verifyReceipt({ ...r.receipt, candidate: { ...r.receipt.candidate, meanMs: 1 } }).valid, false);    // faked speed shows
  assert.equal(verifyReceipt({ ...r.receipt, hash: 'f'.repeat(64) }).valid, false);
  assert.equal(verifyReceipt({ ...r.receipt, kind: 'other' }).ok, false);
  assert.equal(verifyReceipt('x').ok, false);
  assert.equal(verifyReceipt({ kind: 'fallforge-gate-receipt' }).ok, false);             // no hash
  assert.equal(makeReceipt({ ok: false }, { scoredAt: 't' }).ok, false);
  assert.equal(makeReceipt(cmp, {}).ok, false);                                          // no timestamp
  assert.equal(makeReceipt(cmp, { scoredAt: '' }).ok, false);
});

// ═══ kill probes — clause isolation by WHY, forgeries that pass every later check ═══════════════

test('kill: refusals name their TRUE reason — each clause isolated', () => {
  const mk = (probes) => validEvalSet({ name: 'n', task: 't', probes });
  assert.match(mk([{ id: 'q', input: 'i', expect: {} }]).why, /needs an expect object/);        // expect {} — NOT "unknown scorer type"
  assert.match(mk([{}]).why, /needs a string id/);                                              // bare probe object
  assert.equal(mk([{ id: 7, input: 'i', expect: { type: 'exact', value: 'x' } }]).ok, false);   // numeric id — isolates isStr
  assert.equal(mk([{ id: '', input: 'i', expect: { type: 'exact', value: 'x' } }]).ok, false);  // empty id — isolates length
  assert.match(scoreProbe({}, 'x').why, /takes a probe/);                                       // NOT the validExpect message
  assert.match(scoreProbe(7, 'x').why, /takes a probe/);
});

test('kill: isNum refuses NaN and Infinity outright (typeof number is not enough)', () => {
  const mk = (expect) => validEvalSet({ name: 'n', task: 't', probes: [{ id: 'q', input: 'i', expect }] });
  assert.equal(mk({ type: 'number', value: NaN, tolerance: 1 }).ok, false);
  assert.equal(mk({ type: 'number', value: 1, tolerance: NaN }).ok, false);
  assert.equal(mk({ type: 'number', value: Infinity, tolerance: 1 }).ok, false);
});

test('kill: exact scorer speaks the matching why on BOTH sides of the verdict', () => {
  const p = (out) => scoreProbe({ id: 'x', input: 'i', expect: { type: 'exact', value: 'yes' } }, out);
  assert.equal(p('yes').why, 'exact match');
  assert.match(p('nope').why, /expected exactly: yes/);
});

test('kill: json-field missing paths say NOT FOUND — never a value comparison, never a throw', () => {
  const e = { type: 'json-field', field: 'customer.email', value: 'a@b.co' };
  const p = (out) => scoreProbe({ id: 'x', input: 'i', expect: e }, out);
  assert.match(p('{"customer":{"mail":"x"}}').why, /not found/);
  const mid = p('{"customer": 5}');            // non-object mid-path
  assert.equal(mid.pass, false);
  assert.match(mid.why, /not found/);
});

test('kill: makeReceipt refuses an array forgery and a non-string verdict', () => {
  const arr = []; arr.ok = true; arr.verdict = 'BEATS';
  assert.equal(makeReceipt(arr, { scoredAt: 't' }).ok, false);
  assert.equal(makeReceipt({ ok: true, verdict: 7, candidate: {}, baseline: {} }, { scoredAt: 't' }).ok, false);
});

test('receipt: a LOSES receipt is a first-class receipt — the gate can say no', () => {
  const twoMiss = [...PASSING]; twoMiss[0] = 'wrong'; twoMiss[1] = 'wrong';
  const cmp = compare(ES, side('little', twoMiss, 100), side('big', PASSING, 400));
  const r = makeReceipt(cmp, { scoredAt: '2026-09-14T12:00:00Z' });
  assert.equal(r.ok, true);
  assert.equal(r.receipt.verdict, 'LOSES');
  assert.equal(r.receipt.certified, false);
  assert.equal(verifyReceipt(r.receipt).valid, true);
});
