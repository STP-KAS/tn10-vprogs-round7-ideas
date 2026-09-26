// r7 net-fee window v2 (TN10): only SELECTED-CHAIN blocks' coinbases are applied by consensus, so count only those.
// For each added chain block (virtual-chain-changed), getBlock(includeTransactions) -> coinbase outputs; removed chain blocks subtracted.
// subsidy_est = smallest coinbase output seen (a merged blue block that carried no fees). fee part of an output = value - subsidy_est.
// Our runners' fees = delta of fee_tkas in ttt/vprog/covttt rep lines (KNS commit/reveal miner fees NOT included; KNS name prices go to the KNS treasury, not miners).
import { readFileSync, appendFileSync } from "node:fs"; import { kaspa, connect, deskKey, addrOf } from "./lib.mjs";
const D = "/workspace/tn10-break-test-2026-09-25"; const MIN = Number(process.argv[2] || 10); const OUT = `${D}/logs/round7/ledger2.jsonl`;
const OURSPK = kaspa.payToAddressScript(addrOf(deskKey(0))).script; const rpc = await connect("n0");
const per = new Map(); // chain block hash -> outputs [{v, ours}]
const spkHex = (s) => typeof s === "string" ? s : (s?.script || String(s));
const pend = [];
rpc.addEventListener("virtual-chain-changed", (e) => { for (const h of e.data.removedChainBlockHashes) per.delete(h); for (const h of e.data.addedChainBlockHashes) pend.push(h); });
await rpc.subscribeVirtualChainChanged(false);
let stop = false; let fetched = 0, ferr = 0;
(async () => { while (!stop || pend.length) { const h = pend.shift(); if (!h) { await new Promise((r) => setTimeout(r, 50)); continue; }
  try { const b = await rpc.getBlock({ hash: h, includeTransactions: true }); const c = b.block.transactions[0]; per.set(h, c.outputs.map((o) => { const s = spkHex(o.scriptPublicKey); return { v: BigInt(o.value), ours: String(s).endsWith(OURSPK) }; })); fetched++; } catch { ferr++; } } })();
const RUN = ["ttt-T7", "vprog-V7", "covttt-C1"];
const lastRep = (f) => { try { const ls = readFileSync(`${D}/logs/round7/${f}.jsonl`, "utf8").trimEnd().split("\n"); for (let i = ls.length - 1; i >= 0; i--) if (ls[i].includes('"ev":"rep"')) return JSON.parse(ls[i]); } catch {} return null; };
const fees = () => RUN.reduce((a, f) => a + ((lastRep(f) || {}).fee_tkas || 0), 0);
const f0 = fees(), t0 = new Date().toISOString(); appendFileSync(OUT, JSON.stringify({ ev: "start", t: t0, minutes: MIN }) + "\n");
await new Promise((r) => setTimeout(r, MIN * 60000)); const f1 = fees(); stop = true; await new Promise((r) => setTimeout(r, 3000));
const outs = [...per.values()].flat(); const sub = outs.reduce((m, x) => (x.v < m ? x.v : m), outs[0].v);
let tot = 0n, ours = 0n, feeAll = 0n, feeOurs = 0n, nOurs = 0; for (const x of outs) { tot += x.v; const f = x.v - sub; feeAll += f; if (x.ours) { ours += x.v; nOurs++; feeOurs += f; } }
const T = (x) => Number(x) / 1e8; const ourFees = f1 - f0;
const res = { ev: "summary", t0, t1: new Date().toISOString(), minutes: MIN, chain_blocks: per.size, fetched, fetch_err: ferr, coinbase_outputs: outs.length, our_outputs: nOurs, our_output_share: +(nOurs / outs.length).toFixed(3),
  subsidy_est_tkas: T(sub), coinbase_total_tkas: T(tot), coinbase_ours_tkas: T(ours), fees_all_tkas: T(feeAll), fees_back_to_our_miners_tkas: T(feeOurs),
  our_runner_fees_tkas: +ourFees.toFixed(4), our_fee_share_of_all_fees: +(ourFees / T(feeAll)).toFixed(3), returned_vs_our_fees: +(T(feeOurs) / ourFees).toFixed(3), net_cost_tkas: +(ourFees - T(feeOurs)).toFixed(4),
  net_incl_subsidy_tkas: +(ourFees - T(ours)).toFixed(4) };
appendFileSync(OUT, JSON.stringify(res) + "\n"); console.log(JSON.stringify(res)); process.exit(0);
