// r7: sweep the round-5/6 persisted chain ends (/home/box/secure/r5-chains-E.json) back to the faucet. Never prints keys.
// Note: ttt-E and vprog-E both wrote this SAME file (tag collision) -> only one runner's chains are in it.
import { readFileSync, appendFileSync } from "node:fs";
import { kaspa, NET, connect, deskKey, addrOf } from "./lib.mjs";
const L = "/workspace/tn10-break-test-2026-09-25/logs/round7/sweep-e.jsonl";
const FADDR = addrOf(deskKey(0)); const fr = BigInt(readFileSync("/tmp/r6-feerate", "utf8").trim());
const rpc = await connect("n0"); const arr = JSON.parse(readFileSync("/home/box/secure/r5-chains-E.json", "utf8"));
const S = { n: arr.length, ok: 0, spent: 0, orphan: 0, other: 0, tkas: 0 };
for (const c of arr) {
  const key = new kaspa.PrivateKey(c.k); const spk = kaspa.payToAddressScript(c.address); const amt = BigInt(c.amount);
  const mk = (o) => { const t = kaspa.createTransaction([{ address: c.address, outpoint: { transactionId: c.txid, index: c.index }, utxoEntry: { amount: amt, scriptPublicKey: spk, blockDaaScore: 0n, isCoinbase: false } }], [{ address: FADDR, amount: o }], 0n, null, 1); kaspa.signTransaction(t, [key], false); return t; };
  let t = mk(amt - 100000n); t = mk(amt - BigInt(kaspa.calculateTransactionMass(NET, t)) * fr);
  try { await rpc.submitTransaction({ transaction: t, allowOrphan: false }); S.ok++; S.tkas += Number(amt) / 1e8; }
  catch (e) { const m = String(e.message || e); if (/already spent|double spend/.test(m)) S.spent++; else if (/orphan/.test(m)) S.orphan++; else { S.other++; if (S.other < 5) appendFileSync(L, JSON.stringify({ err: m.slice(0, 200) }) + "\n"); } }
}
appendFileSync(L, JSON.stringify({ t: new Date().toISOString(), ...S, tkas: Math.round(S.tkas) }) + "\n"); console.log(JSON.stringify(S)); await rpc.disconnect(); process.exit(0);
