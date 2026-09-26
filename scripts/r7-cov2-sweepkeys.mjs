import { readFileSync, appendFileSync } from "node:fs";
import { kaspa, NET, deskKey, addrOf, connect } from "./lib.mjs";
import { deriveKey } from "./r7-engine.mjs";
const n = Number(readFileSync("/home/box/secure/r7-keyctr-cov2.txt", "utf8")); const FA = addrOf(deskKey(0)); const rpc = await connect("n0"); const fr = BigInt(readFileSync("/tmp/r6-feerate", "utf8").trim());
const ks = Array.from({ length: n }, (_, i) => deriveKey("cov2", i)); const addrs = ks.map(addrOf);
const us = await (await fetch("https://api-tn10.kaspa.org/addresses/utxos", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ addresses: addrs }) })).json();
const S = { utxos: us.length, ok: 0, tkas: 0, rows: [] };
for (const u of us) { const i = addrs.indexOf(u.address); const k = ks[i]; const amt = BigInt(u.utxoEntry.amount); const spk = kaspa.payToAddressScript(u.address);
  const mk = (o) => { const t = kaspa.createTransaction([{ address: u.address, outpoint: u.outpoint, utxoEntry: { amount: amt, scriptPublicKey: spk, blockDaaScore: BigInt(u.utxoEntry.blockDaaScore), isCoinbase: false } }], [{ address: FA, amount: o }], 0n, null, 1); kaspa.signTransaction(t, [k], false); return t; };
  let t = mk(amt - 100000n); t = mk(amt - BigInt(kaspa.calculateTransactionMass(NET, t)) * fr);
  try { await rpc.submitTransaction({ transaction: t, allowOrphan: false }); S.ok++; S.tkas += Number(amt) / 1e8; S.rows.push({ key: i, daa: u.utxoEntry.blockDaaScore, tkas: Number(amt) / 1e8, from: u.outpoint.transactionId }); } catch (e) { S.rows.push({ key: i, err: String(e.message || e).slice(0, 120) }); } }
appendFileSync("/workspace/tn10-break-test-2026-09-25/logs/round7/cov2-recover.jsonl", JSON.stringify({ t: new Date().toISOString(), ev: "sweepkeys", ...S }) + "\n"); console.log(JSON.stringify(S)); process.exit(0);
