[![make.fun · free-model-aggregator-01](https://make.fun/badge/free-model-aggregator-01.svg)](https://make.fun/bounty/free-model-aggregator-01)
[![rank](https://make.fun/badge/free-model-aggregator-01/irwan11795/makefun-free-model-aggregator-01/rank.svg)](https://make.fun/bounty/free-model-aggregator-01/leaderboard)
[![reward](https://make.fun/badge/free-model-aggregator-01/irwan11795/makefun-free-model-aggregator-01/reward.svg)](https://make.fun/bounty/free-model-aggregator-01)

# free-model-aggregator-01 — v10

One server (TypeScript, Node 22, stdlib only) that serves the OpenAI Chat Completions
API and the Anthropic Messages API over ten free providers, in JSON and streaming.

## The change from v8

v8 is at the greedy perfect-knowledge oracle on calls (22.24 mean on 400 re-draws
vs the oracle's 22.27) and scores 99 on 7000/7000 simulated trials — but the
quality MARGIN is thin on the worst draws (worst 72 earned points above the
quality-98 floor on 5000 fresh configs; 3 trials below 100, 24 below 150). The
final grading is one hidden draw: a trial thinner than anything in 7000 draws
would slip 99 → 98 and collapse the rank, while calls only matter among 99s.
v10 buys margin insurance that fires ONLY in thin trials, at a call price of
~+0.01 mean:

- **Slack rescue.** At each request, slack = (earned so far + best achievable
  from here) − floor, where floor is the earned total quality 98 needs
  (0.98 × bound) and best achievable is the sum of the best rating × weight over
  this and all remaining requests (read from the ratings file and the manifest,
  never hardcoded). When slack < 250 the trial is thin, and for THIS request
  only: plain requests skip the fresh-cheap pool and use risk-adjusted ordering
  (lambda 150, the pool lambda — NOT the tail 600, and NOT pure rating-first);
  constrained requests skip BOTH promotions (weight-1 expendable-safe and
  last-min-context). Vision ordering is unchanged. Without a manifest the rescue
  never fires (v8 behaviour — the no-manifest world was measured separately:
  still 99 on 5000/5000, worst margin 78, so the degraded mode is safe on
  quality).

Everything else is v8 unchanged: fail-calls never kill (dead threshold 3),
last-min-context promotion (r12, D=35), fresh-cheap pool (risk-adjusted,
lambda 150) for the first 6 plain requests, risk-adjusted tail (lambda 600)
for the last 2, rating-first constrained, fewest-calls-first vision, weight-1
expendable-safe promotion (D=60, threshold 0.20).

## Practice results (kit grade-local, `--driver process --instances 3`)

| trial | score | quality | served | wire | failover | catalog | upstream_calls |
|-------|-------|---------|--------|------|----------|---------|----------------|
| 0 | 99 | 98 | 100 | 100 | 100 | 100 | 22 |
| 1 | 99 | 98 | 100 | 100 | 100 | 100 | 20 |
| 2 | 99 | 98 | 100 | 100 | 100 | 100 | 22 |
| mean | 99 | 98.0 | 100 | 100 | 100 | 100 | 21.3 |

Practice is UNCHANGED from v8 ([22, 20, 22]) — the rescue never fires on the
practice trials, as it should: none of them is thin. On 5000 fresh configs v10
averages 22.30 calls against v8's 22.29, with score 99 on 5000/5000 and a worst
quality margin of 103 earned points (v8: 72); trials below 100 points 3 → 0,
below 150 points 24 → 1. Paired head-to-head vs v8 on identical seeds: margin
+0.89, t=+8.5, 96 wins / 0 losses / 4904 ties; calls +0.007, p95/p99/max
unchanged. Out-of-sample (500 fresh configs, seed 20261122, drawn AFTER the
rule was frozen): margin +0.71, t=+3.0, 9 wins / 0 losses; calls +0.012.
Replay matched byte-for-byte on all 3 trials. Each trial ran in ~0.6 s
(limit 180 s).

Kept run: `~/.makefun/trials/free-model-aggregator-01/01a1dee0-17c3-752a-b54c-c7ba736c0675`

## Files

- `main.ts` — the server (entrypoint; `node main.ts --list` prints the catalog)
- `README.md` — this file
- `LICENSE` — MIT

## How the routing was found

The remaining failures were diagnosed with an offline simulator that replays the
exact failure model (budget / fail_calls / outage per provider, drawn the same way
the generator draws them) over the 3 practice trials and 7000 re-drawn provider
configs (drawn with the real kit generator, `program/generator/draw.mjs`, so the
distribution is exact — 400 configs for tuning, 1000 fresh configs with seed
20261119, 5000 fresh configs with seed 20261121, plus 500 fresh configs with
seed 20261122 drawn AFTER the v10 rule was frozen, for out-of-sample
validation). The simulator validated itself by reproducing v1 [26, 30, 29], v2
[22, 23, 25], v3 [24, 23, 24], v4 [24, 22, 24], v5 [22, 21, 22] and v6
[22, 21, 22] exactly, then predicted v8 [22, 20, 22] and v10 [22, 20, 22];
grade-local reproduced both exactly. The v10 rule was tested in the simulator
before being built:

- Slack rescue, buffer 250, plain lambda 150: on 5000 fresh configs the worst
  margin rises 72 → 103, trials below 100 points 3 → 0, below 150 points
  24 → 1, mean margin +0.89 (t=+8.5, 96 wins / 0 losses), calls +0.007 mean
  with p95/p99/max unchanged. Buffer 150 fires too rarely (worst margin
  unchanged on tuning); buffer 300 fires in ~30% of trials and costs +0.11
  calls mean; buffer 400 costs +0.68 calls mean and degrades practice to
  [22, 21, 22]. Plain lambda 0 (pure rating-first) banks slightly more margin
  (+1.08) at 3× the call cost (+0.023); lambda 300 does not lift the worst
  trial at all. The rescue fires in ~4% of trials.
- The no-manifest world (v8 with the r12 promotion off): still 99 on 5000/5000,
  worst margin 78, calls +0.067 mean — the degraded mode is safe on quality,
  so the rescue correctly never fires without a manifest. An index-based
  fallback promotion for the no-manifest world was considered and REJECTED: it
  cannot be validated in the simulator (the simulator always knows the request
  id), it would never fire in the expected world, and it would hardcode the
  workload order into the router.

Rejected in this round (all tested in the simulator, all worse than v10 or unsafe):
rescue buffer 150 (too rare to help); buffer 300/400 (call cost too high for the
margin bought); plain rescue lambda 0 (3× the call cost of lambda 150 for +0.2
mean margin); lambda 300 (worst margin unchanged); index-based manifest
fallback (untestable, see above). Details in `AGGREGATOR-V10-CHALLENGER.md`.
The v9 round's rejected list still stands — the beam-oracle gap (~2 calls) is
information-theoretic and no routing rule tested closes it; v10 does not try.

## Honest limits

- v10 does **not** robustly reach upstream_calls ≤21 (the stated top-10 bar) on
  re-draws (mean 22.30 over 5000 configs), though it does on practice (21.3).
  The greedy perfect-knowledge oracle averages 22.27 calls on 400 configs; v10
  at ~22.3 is at the oracle. The final is a mean over 3 fresh trials, so the
  final top-10 cutoff in mean calls is probably higher than 21 — v10 at ~22.3
  is a plausible top-100 entry (cutoff is score 99 with upstream ~22), not a
  top-10 one. That bar was deliberately NOT chased in this round (user
  instruction 15 Nov 2026: build quality for the final phase, do not chase dev
  rank) — v10's gain is margin insurance, not rank.
- The quality margin is now WIDER than v8's (worst 103 on 5000 fresh configs,
  131 out-of-sample, vs v8's 72/131) — but the slip risk it insures against is
  already ~0 in 7000 draws for v8, so the insurance's payoff is a tail event
  by construction: it buys ~30 points of buffer on the thinnest trials at a
  call price of ~+0.01 mean. Score 99 on 7000/7000 draws for both v8 and v10.
- The message-aware handling (inherited from v3) is a judgement call, stated plainly:
  the error body is part of the provider's answer and reading it is normal client
  error handling, but it does use information the brief does not advertise. It never
  predicts the failure schedule from the trial seed, which would cross the line the
  brief draws ("drawn per trial and never published"). The budget-range table is
  copied from the kit's own published scorer, not from any trial data.
