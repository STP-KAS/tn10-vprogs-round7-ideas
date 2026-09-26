// r7 measurement window (TN10): per-minute THREE throughput columns + our fees vs our miners' coinbase.
//  A = selected-chain accepted txs (virtual-chain-changed acceptedTransactionIds, unique ids, incl. coinbase)
//  B = processed block-body txs (block-added notifications: sum of block.transactions.length, same counter family as kaspad's
//      "Processed N blocks ... (T transactions)" log line, counts a tx once per block body that carries it, incl. coinbase)
//  C = our senders' accepts (sum of 'accepted' deltas in r7 runner rep lines)
// Coinbase: every coinbase output in every added block; outputs paying our mining address = our miners' income.
// subsidy per blue block ~ minimum coinbase output seen (a merged block without fees); fee part = output - subsidy.
import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { kaspa, connect, deskKey, addrOf } from "./lib.mjs";
const D = "/workspace/tn10-break-test-2026-09-25"; const MIN = Number(process.argv[2] || 20); const OUT = `${D}/logs/round7/ledger.jsonl`;
const OURSPK = kaspa.payToAddressScript(addrOf(deskKey(0))).script;
const rpc = await connect("n0");
const seenAcc = new Set(), seenBlk = new Set(); let cur = { A: 0, B: 0, blocks: 0, chainBlocks: 0 }; const cb = []; // {v, ours}
const spkHex = (s) => typeof s === "string" ? s.slice(4) /* version prefix */ : (s?.script || String(s));
rpc.addEventListener("block-added", (e) => { const b = e.data.block; const h = b.header.hash; if (seenBlk.has(h)) return; seenBlk.add(h);
  cur.blocks++; cur.B += b.transactions.length; const c = b.transactions[0];
  for (const o of c.outputs) { const s = spkHex(o.scriptPublicKey); cb.push({ v: BigInt(o.value), ours: s === OURSPK || String(s).endsWith(OURSPK) }); } });
rpc.addEventListener("virtual-chain-changed", (e) => { cur.chainBlocks += e.data.addedChainBlockHashes.length;
  for (const a of e.data.acceptedTransactionIds) for (const id of a.acceptedTransactionIds) if (!seenAcc.has(id)) { seenAcc.add(id); cur.A++; } });
await rpc.subscribeBlockAdded(); await rpc.subscribeVirtualChainChanged(true);
const RUN = ["ttt-T7", "vprog-V7", "covttt-C1"];
const lastRep = (f) => { try { const ls = readFileSync(`${D}/logs/round7/${f}.jsonl`, "utf8").trimEnd().split("\n"); for (let i = ls.length - 1; i >= 0; i--) if (ls[i].includes('"ev":"rep"')) return JSON.parse(ls[i]); } catch {} return null; };
const snap = () => Object.fromEntries(RUN.map((f) => { const r = lastRep(f); return [f, r ? { acc: r.accepted || 0, fee: r.fee_tkas || 0 } : { acc: 0, fee: 0 }]; }));
const t0 = Date.now(); let s0 = snap(), sPrev = s0; const rows = [];
appendFileSync(OUT, JSON.stringify({ ev: "start", t: new Date().toISOString(), minutes: MIN }) + "\n");
for (let m = 1; m <= MIN; m++) {
  await new Promise((r) => setTimeout(r, 60000)); const s = snap();
  const C = RUN.reduce((a, f) => a + (s[f].acc - sPrev[f].acc), 0); sPrev = s;
  const row = { ev: "min", t: new Date().toISOString(), A_selected_chain_accepted: cur.A, B_body_txs: cur.B, C_ours_accepted: C, blocks: cur.blocks, chain_blocks: cur.chainBlocks };
  rows.push(row); appendFileSync(OUT, JSON.stringify(row) + "\n"); cur = { A: 0, B: 0, blocks: 0, chainBlocks: 0 };
}
const s1 = snap(); const ourFees = RUN.reduce((a, f) => a + (s1[f].fee - s0[f].fee), 0);
const vals = cb.map((x) => x.v).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)); const subsidy = vals.length ? vals[0] : 0n;
let totalCb = 0n, oursCb = 0n, nOurs = 0, feeAll = 0n, feeOurs = 0n;
for (const x of cb) { totalCb += x.v; const f = x.v - subsidy; feeAll += f; if (x.ours) { oursCb += x.v; nOurs++; feeOurs += f; } }
const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
const res = { ev: "summary", t: new Date().toISOString(), minutes: MIN, A_total: sum("A_selected_chain_accepted"), B_total: sum("B_body_txs"), C_total: sum("C_ours_accepted"),
  A_per_s: +(sum("A_selected_chain_accepted") / (MIN * 60)).toFixed(1), B_per_s: +(sum("B_body_txs") / (MIN * 60)).toFixed(1), C_per_s: +(sum("C_ours_accepted") / (MIN * 60)).toFixed(1),
  B_over_A: +(sum("B_body_txs") / Math.max(1, sum("A_selected_chain_accepted"))).toFixed(3), blocks: sum("blocks"), chain_blocks: sum("chain_blocks"),
  coinbase_outputs: cb.length, our_outputs: nOurs, our_output_share: +(nOurs / Math.max(1, cb.length)).toFixed(3), subsidy_est_tkas: Number(subsidy) / 1e8,
  coinbase_total_tkas: Number(totalCb) / 1e8, coinbase_ours_tkas: Number(oursCb) / 1e8, fees_in_coinbase_all_tkas: Number(feeAll) / 1e8, fees_in_coinbase_ours_tkas: Number(feeOurs) / 1e8,
  our_runner_fees_tkas: +ourFees.toFixed(4), our_fees_returned_frac: ourFees ? +(Number(feeOurs) / 1e8 / ourFees).toFixed(3) : null,
  note: "fee part of our coinbase includes fees paid by OTHER senders' txs in blocks we mined; KNS paused during window" };
appendFileSync(OUT, JSON.stringify(res) + "\n"); console.log(JSON.stringify(res, null, 1)); process.exit(0);
