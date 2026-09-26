// r7: sweep every persisted KNS worker key (/home/box/secure/r6-kns-workers.txt) back to the faucet via the live public API UTXO list. Never prints keys.
import { readFileSync, appendFileSync } from "node:fs";
import { kaspa, NET, connect, deskKey, addrOf } from "./lib.mjs";
const L = "/workspace/tn10-break-test-2026-09-25/logs/round7/sweep-kns.jsonl"; const FADDR = addrOf(deskKey(0)); const fr = BigInt(readFileSync("/tmp/r6-feerate", "utf8").trim());
const ws = [...new Set(readFileSync("/home/box/secure/r6-kns-workers.txt", "utf8").split("\n").filter(Boolean))].map((h) => { const key = new kaspa.PrivateKey(h); return { key, addr: addrOf(key) }; });
const rpc = await connect("n0"); const S = { workers: ws.length, with_coins: 0, txs: 0, tkas: 0, fail: 0 };
for (let i = 0; i < ws.length; i += 50) {
  const part = ws.slice(i, i + 50);
  const us = await (await fetch("https://api-tn10.kaspa.org/addresses/utxos", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ addresses: part.map((w) => w.addr) }) })).json();
  for (const w of part) { const mine = us.filter((u) => u.address === w.addr); if (!mine.length) continue; S.with_coins++;
    const spk = kaspa.payToAddressScript(w.addr);
    for (let k = 0; k < mine.length; k += 80) { const grp = mine.slice(k, k + 80);
      const ins = grp.map((u) => ({ address: w.addr, outpoint: u.outpoint, utxoEntry: { amount: BigInt(u.utxoEntry.amount), scriptPublicKey: spk, blockDaaScore: BigInt(u.utxoEntry.blockDaaScore), isCoinbase: false } }));
      const tot = ins.reduce((a, x) => a + x.utxoEntry.amount, 0n);
      let t = kaspa.createTransaction(ins, [{ address: FADDR, amount: tot - 1n }], 0n, null, 1); kaspa.signTransaction(t, [w.key], false);
      t = kaspa.createTransaction(ins, [{ address: FADDR, amount: tot - BigInt(kaspa.calculateTransactionMass(NET, t)) * fr }], 0n, null, 1); kaspa.signTransaction(t, [w.key], false);
      try { await rpc.submitTransaction({ transaction: t, allowOrphan: false }); S.txs++; S.tkas += Number(tot) / 1e8; } catch (e) { S.fail++; appendFileSync(L, JSON.stringify({ err: String(e.message || e).slice(0, 200) }) + "\n"); } } } }
appendFileSync(L, JSON.stringify({ t: new Date().toISOString(), ...S, tkas: Math.round(S.tkas) }) + "\n"); console.log(JSON.stringify(S)); process.exit(0);
