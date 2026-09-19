# FallForge Gate

> **Superseded, not deleted.** This repo's proof-of-play logic (deterministic scoring, no LLM
> judge, a verdict that can say LOSES) has been absorbed into
> [fallforgemint](https://github.com/sjgant80-hub/fallforgemint)'s own kernel — the current, live
> mint pipeline gates every candidate the same way this repo pioneered. This page stays live and
> gated as a historical record of layer 1 of the original sovereign-node factory; new work happens
> in fallforgemint and the converging [fallforge](https://github.com/sjgant80-hub/fallforge) hub.

**LIVE: https://sjgant80-hub.github.io/fallforge-gate/**

Proof-of-play for small language models — layer 1 of the sovereign-node factory.

A tuned SLM is worth exactly what it can prove. This harness measures a **candidate** model
against a **baseline** on a named use-case and seals the numbers into a tamper-evident receipt:

- **Deterministic scorers only** — exact match, required substrings, numeric tolerance, JSON
  field checks. No LLM judge: correlated checkers give false confidence.
- **A verdict that can refuse** — under 10 probes is not evidence; an equal score is not a win;
  the verdict can and does say **LOSES**. A gate that cannot say no is not a gate.
- **Receipts are scoped and hashed** — "on THIS probe set, measured", canonically serialized,
  SHA-256 sealed. Flip a verdict, inflate a margin, sandbag the baseline — the hash breaks, and
  the live page shows it.

## The shipped receipt is a refusal

The repo ships a real receipt of a real run — `llama3.2:1b` (candidate) vs `qwen2.5:7b`
(baseline) on a 16-probe support-triage eval: **LOSES** — 11/16 vs 15/16, −25% pass delta,
3.26× faster. The first receipt this gate ever issued says *no*. That is what makes a *yes*
worth money: when FallForge (layer 2) mints a tuned SLM that flips this receipt to BEATS,
the claim is measured, not asserted.

The live page carries the gated kernel verbatim and re-verifies the shipped receipt in your
browser on load. CI re-runs the mutation gate, re-verifies the receipt against the kernel,
and fails if the page drifts from the source.

## Run your own

```bash
node --test kernel.test.mjs                            # the suite
node tools/witness.mjs mutate kernel.mjs --timeout 20000 --cap 400 --test node --test kernel.test.mjs   # the gate
node runner-ollama.mjs evalsets/support-triage.json <candidate> <baseline> receipt.json      # a real eval vs a local Ollama
node make-page.mjs                                     # regenerate the page from the gated kernel
```

Eval sets are plain JSON: `{ name, task, probes: [{ id, input, expect }] }` with expect types
`exact` · `contains` · `number` · `json-field`.

## Honest limits (v1)

Receipts are hash-self-verified — tamper-evident, **not yet signed** (Ed25519 via the-wallet is
v2; today a receipt proves internal consistency, not issuer). Deterministic scorers cover
extraction/classification/structured output — the use-cases SLMs are minted for — not open-ended
prose. Latency is comparable within a receipt, not across machines.

MIT.
