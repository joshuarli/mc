# Frontier S6 bounded search

## Predeclared screen

Search `frontier-v1`'s seven policy parameters with `coordinateSearchProposals`; leave tactical-only `lootFirstRangeBlocks` and `kiteRangeBlocks` at zero. The control is the checked-in default. Use seed `500001`, coordinate round 0, and the first four proposals. The resulting proposals each change one parameter: `borderMarginBlocks` 3, `borderMarginBlocks` 1, `eatAtHungerOrBelow` 10, and `eatAtHungerOrBelow` 6.

The first fidelity is deterministic proposal generation, candidate compilation, and the existing safety-priority regression. The second fidelity runs the default and four proposals on `scenarios/uhc-bow.toml`, seed `710124`, one round, concurrency 1, with both seat assignments against frozen `baseline`. A candidate is eligible for the screen score only if both assignments complete and each records PvP hits and candidate damage. This prevents a border win or passive survival from ranking as combat improvement.

Rank eligible candidates by paired mean score, then fewer self-inflicted attack rejections per issued attack, then higher candidate survival across the two assignments. If those values tie, retain the default. Also report PvP hits, contact, damage dealt and taken, attack funnel reasons, failures, and degradation. This one-seed microarena screen is not a promotion result. Do not use held-out seeds. Run the natural hunger and faction fidelity only after this screen identifies a candidate worth carrying forward.

## Results

The coordinate helper produced the four declared proposals. All ten matches completed without disconnects or degraded runs. Every assignment recorded PvP hits and candidate damage, so all five pairs qualified for the screen score.

| Variant | Parameter change | Wins | PvP hits | Candidate damage dealt/taken | Self-inflicted rejections/issued | Candidate survived |
|---|---|---:|---:|---:|---:|---:|
| Default | none | 0/2 | 16 | 0.8/44.9 | 3/2 | 0/2 |
| Proposal 1 | `borderMarginBlocks=3` | 0/2 | 20 | 12.2/48.7 | 5/4 | 0/2 |
| Proposal 2 | `borderMarginBlocks=1` | 0/2 | 20 | 9.3/49.1 | 2/3 | 0/2 |
| Proposal 3 | `eatAtHungerOrBelow=10` | 2/2 | 15 | 45.9/9.3 | 3/20 | 2/2 |
| Proposal 4 | `eatAtHungerOrBelow=6` | 1/2 | 14 | 20.8/21.8 | 5/7 | 1/2 |

The paired mean scores were 0, 0, 0, 1, and 0.5 in table order. `eatAtHungerOrBelow=10` ranks first by paired mean and also had the lowest self-inflicted rejections per issued attack among the proposals. Its candidate funnel recorded two `ownershipDeferred` rejections and one `outOfGeometricReach` rejection. It won once by melee and once by projectile damage. The control and proposals 1 and 2 lost both assignments. Proposal 4 won the first assignment and lost the seat-swapped assignment.

The winning parameter set is a transfer-check candidate, not a promoted policy. It used one seed and remains above the under-5% duel rejection gate at 3/20. The live trace directories are `.work/arena/runs/s6-micro2-ds6b0-s710124-r0-a0` through `s6-micro2-ds6b4-s710124-r0-a1`.

The coordinate helper regression passed before this live screen. The screen did not consume held-out seeds.

## Natural hunger transfer

The league `s6-hunger-10` ran `scenarios/hunger-six.toml` on regression seed `481516`, with `eatAtHungerOrBelow=10` against `baseline` and both seat assignments. Both matches completed without disconnects or degradation. The candidate had no wins, one draw, and one loss. Its mean score was `0.25`, and its survival fraction was `1/6` compared with `2/6` for baseline.

The report failed the loot gate at `0.583` against a `0.75` threshold and the self-inflicted rejection gate at `0.632` against `0.05`. It passed the termination, PvP elimination, illegal attack, and unexplained idle gates. The league verdict was `keep_baseline`, with `survival_regression`. The report is `.work/arena/league/s6-hunger-10/report-0001.json`.

The UHC duel screen did not transfer to natural Hunger Games. Do not carry this parameter set into S7 or consume held-out seeds. The faction mode does not call `frontier-v1`; `live-policy-loop.ts` calls `decideCivilization` directly for civilization matches. A faction match would not measure this parameter change, so no faction transfer run was made.
