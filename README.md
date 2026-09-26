> **Experimental only. Testnet-10 only. Not a product, not advice, not Kaspa core, not an audit.**

# TN10 vprogs round 7: new ideas, covenant prototypes, and the measurements the reviews asked for

26 Sep 2026, 15:31–~16:30 CEST. Kaspa **testnet-10 only**. One operator (STP-KAS) plus Grok Bot. Round 7 follows rounds 1–6:

- Synthesis / front door: [tn10-vprogs-stress-findings](https://github.com/STP-KAS/tn10-vprogs-stress-findings)
- Rounds: [1](https://github.com/STP-KAS/grok-bot-vprogs-round1-public) · [2](https://github.com/STP-KAS/grok-bot-vprogs-round2) · [3](https://github.com/STP-KAS/grok-bot-vprogs-round3) · [4](https://github.com/STP-KAS/grok-bot-vprogs-round4) · [5](https://github.com/STP-KAS/grok-bot-vprogs-round5) · [6](https://github.com/STP-KAS/grok-bot-vprogs-round6)
- Outside reading of those rounds: [tn10-vprogs-build-opinion](https://github.com/STP-KAS/tn10-vprogs-build-opinion). Our point-by-point reply is [tn10-vprogs-grokbot-opinion](https://github.com/STP-KAS/tn10-vprogs-grokbot-opinion).

No wallet keys, seeds or mnemonics are in this repository. Wallet addresses in logs are replaced by `<addr>`. Transaction ids are left in so that anyone can look them up.

## What

1. **CovTTT: tic-tac-toe whose rules are enforced by L1 consensus.** It is a SilverScript v1.0.0 covenant (`covenants/covttt.sil`, compiled artifact `covttt.json`, 1,806-byte redeem script). The game state (both players' x-only pubkeys, turn, 9 cells, max fee) lives inside the P2SH redeem script. Each move spends the pot UTXO into a new pot whose script has the new state (`validateOutputState` on output 0). The script checks the signer, whose turn it is, the cell range, that the cell is empty, and that no one has already won. The winner claims the pot, or both split it on a draw. **There is no off-chain runtime, no prover, and no indexer.** Every rule is checked by every TN10 node.
2. **Adversarial probes against CovTTT.** For each game, the runner also builds and submits illegal spends: value theft, wrong signer, occupied cell, cell out of range, move after a win, tampered state, turn not flipped, and premature claim. These are real signed transactions submitted to the node. A pass means the node rejected them.
3. **CovTTT2: the same game with liveness.** It adds a `timeout` entry (`this.ageDaa >= ttl`, relative lock with `sequence = ttl`), so a player who stalls loses the pot to the waiting player. We tested whether the lock can be beaten.
4. **The round-6 index-free runners, continued** (ttt T7, vprog V7) at **2× the node's normal fee estimate, minimum 200 sompi/g**. They were rebuilt with per-runner derived keys to fix a round-5/6 chain-file collision (see Flaws).
5. **KNS random-name runner, continued** (R7b, then R7c). It was fixed so it no longer abandons funded workers.
6. **Measurements that the build-opinion listed as missing:**
   - three TPS columns;
   - our fees vs our miners' coinbase over one window;
   - the mempool cap check (source path + what is feasible).
7. Designs, not yet run: see [Ideas](#ideas).

## Measurements (all TN10, our node n0, rusty-kaspa v2.1.0, no utxoindex)

### CovTTT on L1 (runner C1, 13:44 → still running)

| Metric | Value at 16:06 CEST |
|---|---|
| Games finished | **625** (X / O / draw ≈ 57 / 29 / 14 %) |
| Moves (L1 covenant spends) | 4,754 |
| Illegal probes submitted | **2,006** |
| Illegal probes rejected by consensus | **2,006 (100 %)**, 0 accepted |
| Probe mix | value_theft, wrong_signer, occupied_cell, cell_out_of_range, move_after_win, state_tamper, turn_not_flipped, premature_claim (each ≈ 150–310) |
| Mass per move | 6,516 grams (the 1.8 KB redeem script is carried in every spend) |
| Fee per move at 200 sompi/g | ≈ 0.013 TKAS; runner fee total 62.3 TKAS → **≈ 0.10 TKAS per finished game** |
| Submit→accepted latency | p50 **451 ms**, p95 **989 ms** |

Every probe was rejected with `failed to verify the signature script: script ran, but verification failed`. That is the covenant saying no, not the client. Example games (fund, every move txid, claim) are in [`logs/covttt-C1-games.jsonl`](logs/covttt-C1-games.jsonl). Periodic counters are in [`logs/covttt-C1-reps.jsonl`](logs/covttt-C1-reps.jsonl).

Compare this with rounds 5–6. There, the "illegal moves refused" were refused **in the client**, before any transaction existed (the build-opinion is right about that). Here, the illegal transaction is built, signed and submitted, and **L1 consensus** refuses it.

### CovTTT2 timeout: can a relative lock be beaten? (`logs/cov2-locktest.jsonl`)

TTL = 100 DAA. "Chained" means the timeout was submitted while the move it spends was still in the mempool.

| Case | n | Result |
|---|---|---|
| Timeout with the parent move already accepted, age ≈ 2 DAA | 3 | **Rejected at submit**: `one of the transaction sequence locks conditions was not met` |
| Timeout with `sequence = 0` | 1 | Rejected by the script: `Unsatisfied lock time … 100 > 0`. The covenant forces the sequence. |
| Chained timeout, exact acceptance DAAs (with correct txids) | 4 | Admitted to the mempool. 3 were mined at age **101, 103, 103** DAA (≥ 100). 1 was never mined; its pot stayed in the covenant and was later recovered with a mature timeout. |
| Chained timeout, earlier runs (txids were wrong, see below) | 5 | All pots ended at the waiting player after age ≥ 100. One exact (**102**), the others estimated from UTXO DAA scores. |

**Result: consensus held the relative lock in every case. No bypass.** What we did see is mempool behaviour: kaspad **admits** a sequence-locked child whose parent is still in the mempool, and it cannot know the lock age yet. The child is mined only once the lock matures, or it is dropped. A naive client that treats "submit OK" as "timeout claimed" is wrong for about 10 s here, and forever in the dropped case.

**SDK trap found on the way (kaspa-wasm, rusty-kaspa v2.1.0 tree):** `createTransaction` ignores a `sequence` field in the input entry. If you then set `tx.inputs[0].sequence` yourself, the cached `tx.id` is **not** refreshed until you call `tx.finalize()`. The transaction still validates (signatures cover the real sequence). But the id you track is wrong, so it looks as if it was never accepted, and child spends built on it are orphans. Our first "early timeout accepted" reading came from this, and it was wrong. Fixed in the scripts with `tx.finalize()`.

Not measured: a wrong-waiter timeout probe (paying the player whose turn it is). The script rule exists; no on-chain probe has been run yet.

### Three TPS columns (build-opinion item 2), 20 min, 15:46:27–16:06:27 CEST (`logs/ledger.jsonl`)

| Column | Definition | Total | Per second |
|---|---|---|---|
| **A** selected-chain accepted | unique tx ids in `virtual-chain-changed` acceptedTransactionIds (incl. coinbase) | 320,679 | **267.2** |
| **B** processed block-body txs | Σ `block.transactions.len()` over `block-added` (the counter behind kaspad's "Processed N blocks" line, and our rounds 1–4 "network TPS") | 428,690 | **357.2** |
| **C** our senders' accepts | Δ `accepted` in ttt T7 + vprog V7 + CovTTT C1 | 246,000 | **205.0** |

- **B/A = 1.337.** The body counter overstates selected-chain throughput by about a third at this load, because a transaction sits in more than one parallel block. Per minute, B/A ranged 1.28–1.47.
- Blocks: 13,016 in 20 min (**10.85 blocks/s**). Chain-block additions were 8,658 (7.2/s gross). In the v2 window, after subtracting reorged-out chain blocks, **~5.6 selected-chain blocks/s** remained.
- C/A ≈ 77 %. Our runners were most of TN10's accepted load in this window. KNS was also running (971 creates in the window, not in C).
- Rounds 1–4 quoted B-type numbers as "network TPS". Rounds 5–6 quoted C-type numbers. Neither was A.

### Our fees vs our miners' coinbase (build-opinion item 3)

10 min, 16:03:19–16:13:22 CEST, **selected-chain blocks only** (`scripts/r7-ledger2.mjs`, [`logs/ledger2.jsonl`](logs/ledger2.jsonl)). For every chain block added by `virtual-chain-changed`, we fetched its coinbase via `getBlock`. Reorged-out chain blocks were subtracted (4,116 fetched, 712 removed, 3,404 kept). Subsidy estimate = smallest coinbase output = **3.0868 TKAS** per blue block. Fee part of an output = value − subsidy.

| Quantity | Value |
|---|---|
| Coinbase outputs (blue block rewards) | 6,582 (10.9/s), of which **ours 3,511 = 53.3 %** |
| Coinbase value total / ours | 20,928.2 / **11,359.1 TKAS (54.3 %)** |
| Check | 6,582 × 3.0868 + 611.1 = 20,928 ✓ |
| All fees in accepted txs (chain) | **611.1 TKAS** |
| Fee part landing with our miners | **521.5 TKAS (85 % of all fees)** |
| Our runners' fees (ttt + vprog + CovTTT) | **458.5 TKAS (75 % of all fees)** |
| **Net fee cost** (our fees − fee part to our miners) | **−63.0 TKAS**, i.e. no net fee cost in this window |
| Our miners' total coinbase − our fees | +10,900.6 TKAS |

Reading:
- In this window, with 4 local miners, **our fees came back in full**. Our miners collected 85 % of all fee value while finding 53 % of blocks. The likely reason is that our miners build on n0, which sees our own transactions first. That is plausible but not proven.
- The round-5/6 sentence "~57 % of coinbase … came back" was an operator estimate. This window says 54 % of coinbase value and 85 % of fees.
- It does **not** carry over to the storm hours of rounds 1–6. Load, miner share and fee rates were different then, so their gross fee totals stay gross.
- Not in the table: KNS commit/reveal miner fees (small), and **KNS name prices** (8,190 TKAS in the same ~10 min by R7c). Those go to the KNS treasury, not to miners. They are the real net drain of round 7.
- The pool miner's rewards go to the pool's address and are not counted as ours.
- A first 20-min window (`logs/ledger.jsonl`, v1) summed coinbases of **all** blocks, not just chain blocks. Its coinbase and fee totals are wrong by roughly the blocks / chain-blocks ratio and are not used.

### KNS

- R7b (15:45–16:01): 998 names created by its client counter. It spent **90,300 TKAS in KNS prices**: 113 four-character names at 525 TKAS = 59k, the rest at 35 TKAS. The faucet fell from 97.6k to 35k TKAS. At 16:01 it was throttled to R7c (5+ character names only, 35 TKAS max, concurrency 2).
- **None of the names can be confirmed yet.** A random sample of 60 "created" names (20 from each of round 6 A, round 6 B and round 7) all return `available: true` on `POST /domains/check`. The owner endpoint says `NG (580736120) is lagging behind BlockDag (580998852)`: the KNS indexer is **~262.7k DAA** behind, older than every name we created. So "created" is our client counter only. Whether a name is registered or lost cannot be decided until the indexer catches up. Evidence: [`evidence/kns-check-sample.json`](evidence/kns-check-sample.json).

### Public endpoints (re-read 15:59 CEST)

- `api-tn10.kaspa.org/info/health` is still frozen: kaspad blueScore 568,825,293, `isSynced: true`, v2.0.1. `virtual-chain-blue-score` is 569,480,475, so the health document is 655,182 blue behind.
- `vprogs-tt.izio.fr/api/state`: settled DAA **580,992,172** (txid `35ea68e2…`) vs our virtual ≈ 580,998,300, a gap of ≈ 6.1k DAA. At 15:47 it was still at 580,940,363 (gap ≈ 49.7k). Settlement moves **in jumps**. A single reading is not a stall or a recovery.

## Why

- Rounds 5–6 showed that L1 can carry very high chains of small payload txs. They did not show program rules being enforced by anyone but our own client. CovTTT moves the rule check into consensus, the strongest "prover" available on TN10 today, at the price of 6.5k mass per move.
- The reviews (build-opinion, and our own synthesis) asked for three specific measurements. Two are possible on this box today, and they are here.

## How

- Node: n0 kaspad v2.1.0, TN10, `--ram-scale` unchanged from earlier rounds, **no utxoindex**. UTXO lookups for our own derived addresses go through the public `POST /addresses/utxos` (live), not `GET` (stale).
- Covenant: SilverScript v1.0.0 compiler (`silverc`). State is encoded exactly as the artifact's `state_span`. The encoder was checked against the cli-debugger (no-signature tests pass).
  - The SDK's `createInputSignature` returns a push with a 0x41 prefix. Strip one byte before `addData`.
  - Inputs need `sigOpCount ≥ 4`, or you get `script units exceeded (used=113197)`.
  - The covenant also checks `output value ≥ input − maxFee`, because `validateOutputState` does not lock the amount by itself.
- Keys: every game, chain and KNS worker key is `sha256(seed | tag | i)`. The counter is fsync'd **before** funding, so every funded key is recoverable. That is how the stranded test pots and the KNS workers below were recovered.
- Fees: `/tmp/r6-feerate` = max(2 × node normal estimate, 200) sompi/g, refreshed continuously.
- Guard (`scripts/r7-guard.py`): pauses on disk (< 11 G games, < 10 G KNS, < 8.5 G halt all), mempool > 90k, RAM < 1 G, or faucet < 1.5k. Pruning rule: pause at 18:30, and if free disk is < 20 G at 18:45, stop the node cleanly for the operator to decide.
- Scripts: [`scripts/`](scripts). The ledgers are `r7-ledger.mjs` (v1, three columns) and `r7-ledger2.mjs` (v2, chain-only coinbase).

## Sources

- rusty-kaspa v2.1.0:
  - `mining/src/mempool/config.rs` (default max tx count 1,000,000; `apply_ram_scale` only scales down)
  - `mining/src/mempool/validate_and_insert_transaction.rs` (count assert after `limit_transaction_count`)
  - `consensus/src/pipeline/body_processor/processor.rs` and `monitor.rs` (column B)
- SilverScript v1.0.0 docs and examples; kaspa-wasm SDK from the same tree.
- kaspanet/vprogs draft PR #165, head `081af9b9` (= `release-candidate`); vprogs master `f9b84a8`; biryukovmaxim/vprog-tictactoe master `803a120`.
- STP-KAS/kaspa-master-file (THINK-BIG, VPROG-TICTACTOE, intel pack) for the idea list.

## Flaws (ours, found or made in round 7)

1. **Chain-file collision (rounds 5–6).** ttt-E and vprog-E both saved chain keys to the **same** file. One runner's ~800 chain ends were overwritten and can't be recovered: an estimated ~10k TKAS, **not measured**. The surviving 800 chains (10,680.5 TKAS) were swept back (`logs/sweep-e.jsonl`). Round-7 runners use per-tag files and derived keys.
2. **KNS worker abandon.** The round-6 logic dropped a funded worker on any commit failure (`sequence locks`, `already spent`). In ~5 minutes of round 7 it parked **74,114 TKAS in 54 workers**. All of it was swept back because the keys had been saved first (`logs/sweep-kns.jsonl`). Fix: keep the worker, refresh its UTXOs, and cap the price. The round-6 "~26k stranded" loss was the same family of bug.
3. **KNS spend rate.** Even fixed, the default price cap (525 TKAS) let 4-character names burn 59k TKAS in 15 min. It is now capped at 35.
4. **Guard deleted manual pauses.** The guard removed `/tmp/r7-kns.PAUSE` every 60 s, so the "KNS paused during the ledger window" plan did not happen. KNS ran (971 creates). Fixed: manual pause is now `/tmp/r7-kns.MANUAL`.
5. **Ledger v1 overcounts coinbase.** It summed coinbase outputs of **all** added blocks. Only selected-chain blocks' coinbases are applied (13,016 blocks vs 8,658 chain blocks in the window). Its fee and coinbase totals are kept in the log but not used. v2 counts chain blocks only.
6. **Wrong txids from the SDK `sequence`/`finalize()` trap** (above). This briefly produced a false "timeout accepted early" reading. It was corrected before publishing.
7. **CovTTT v1 has no liveness** (a stalling player locks the pot; v2 fixes this). Players' keys are held client-side. The 1.8 KB P2SH script is carried in every move.
8. **Ops slip.** A pattern kill on a throwaway simnet matched its own shell. No TN10 process was affected. Kills are exact-pid only from now on.

## Not done today, and why

- **Upstream vprog-tictactoe on PR #165 head under a storm, on a `--utxoindex` node** (build-opinion item 1). **Not feasible on this box today.**
  - The Rust toolchain was deleted in the morning disk emergency, and a rebuild needs ~5–9 GB.
  - `--utxoindex` costs ~13 GB and ~18.5 min of node downtime.
  - Free disk is ~13 GB, and TN10 pruning around 19:00 needs headroom.
  - It needs either a second lean node or a larger disk, plus the operator's decision.
- **Mempool cap assert at the default cap.** kaspad refuses `--ram-scale < 0.1` (tested on a throwaway simnet node, 15:47–15:50). So the only caps are 100,000 (0.1, where the round-1 crash happened) and the default 1,000,000. A default-cap test needs ~1M txs in a mempool on a throwaway node, and several GB of RAM this box does not have spare. **Not run.** The n0 rule (mempool < 100k) was kept. The source path is explained in the opinion repo.

## Ideas

Designs for the next rounds. **None of these has been measured unless it says so.**

1. **Escrow / 2-of-3 with timeout refund.** The same state-in-script pattern as CovTTT2: buyer and seller sign, or an arbiter signs with one of them, or the refund path opens after `ageDaa ≥ ttl`.
2. **Commit–reveal randomness game.** Both players commit `H(secret)` in the state, then reveal. The covenant checks the hashes and XORs the secrets to decide a coin flip. Timeout: whoever fails to reveal loses.
3. **On-chain voting counter.** State is a tally. Each spend adds one vote signed by a key from a Merkle allow-list (proof in the witness). Measure: mass vs list depth.
4. **Sealed-bid auction.** Commit phase and reveal phase. Pot and refunds are enforced by the covenant.
5. **KNS-gated game rooms.** Only an owner of a KNS name may join. This needs the KNS indexer caught up, so it is blocked today (see KNS above).
6. **CovTTT under storm.** Run the covenant game while the index-free runners saturate blocks. Measure p95 move latency vs feerate, and whether the 6.5k mass per move is priced out first.
7. **Mass diet for covenants.** Move the constant script part into a template-hash check (`covttt.json` has `template_hash`), so each move carries less.

## Other

- Runners live at the time of writing: ttt T7, vprog V7, CovTTT C1, KNS R7c, and the guard. All stop with one file (`/tmp/r7.HALT`). See [STATUS.md](STATUS.md).
- Round-7 runner fees had no net cost in the measured window (fee section). KNS name prices are a pure cost.

---

Standard disclaimer. This GitHub, not the topic above. Testnet only. Intentions are good; thought process is questionable.
