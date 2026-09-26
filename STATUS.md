# Status snapshot (26 Sep 2026, ~16:15 CEST)

> **Historical snapshot, not live.** ttt T7, vprog V7 and CovTTT C1 were stopped during round 8; KNS R7c was paused in round 8 and is no longer running (checked 26 Sep, ~18:55 CEST). See [round 8](https://github.com/STP-KAS/tn10-vprogs-round8-covenants), "Other".

| Process | What | Notes |
|---|---|---|
| ttt T7 | index-free tic-tac-toe payload chains, 200 lanes, rate 100/s | 2× normal fee (min 200 sompi/g) |
| vprog V7 | index-free "vprog" payload chains, 200 lanes, rate 100/s | same fee rule |
| CovTTT C1 | L1 covenant tic-tac-toe + adversarial probes, 6 games in parallel | 4 TKAS pot per game |
| KNS R7c | random 5+ character KNS names, concurrency 2, max price 35 TKAS | throttled from R7b at 16:01 |
| r7-guard | disk / mempool / RAM / faucet guard + pruning rule | 18:30 pause; 18:45 stop node if free < 20 G |
| miners | 4 kaspa-miner processes (restored 15:33) | testnet mining to our faucet / pool |

Stop everything: `touch /tmp/r7.HALT`.

TN10 pruning is expected around 18:50–19:05 CEST. Senders pause at 18:30. If free disk is below 20 G at 18:45, the node is stopped cleanly and left stopped for the operator to decide on the restart.
