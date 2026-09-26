// r7: recover CovTTT2 test pots stuck in "X played cell 4, O to move" state, via a MATURE timeout (seq=TTL, parent confirmed).
// Addresses are deterministic from derived keys -> found on the public API. Never prints keys.
import { readFileSync, appendFileSync } from "node:fs";
import { kaspa, NET, deskKey, addrOf, connect } from "./lib.mjs";
import { deriveKey } from "./r7-engine.mjs";
const D = "/workspace/tn10-break-test-2026-09-25"; const LOG = `${D}/logs/round7/cov2-recover.jsonl`;
const ART = JSON.parse(readFileSync(`${D}/covenants/covttt2.json`, "utf8")).contracts.CovTTT2; const BC = Buffer.from(ART.compiled.bytecode); const SP = ART.compiled.state_span;
const PRE = BC.subarray(0, SP.offset).toString("hex"), SUF = BC.subarray(SP.offset + SP.len).toString("hex"); const TAG = ART.entries.timeout.dispatch_tag;
const i64 = (v) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v)); return "08" + b.toString("hex"); };
const enc = (s) => "20" + s.px + "20" + s.po + i64(s.turn) + s.c.map(i64).join("") + i64(10000000n) + i64(100n);
const red = (s) => PRE + enc(s) + SUF; const spk = (s) => kaspa.payToScriptHashScript(red(s)); const adr = (s) => kaspa.addressFromScriptPublicKey(spk(s), NET).toString();
const fr = BigInt(readFileSync("/tmp/r6-feerate", "utf8").trim()); const FA = addrOf(deskKey(0)); const rpc = await connect("n0");
const n = Number(readFileSync("/home/box/secure/r7-keyctr-cov2.txt", "utf8")); const S = { pairs: 0, found: 0, recovered: 0, tkas: 0, fail: [] };
for (let i = 0; i + 1 < n; i += 2) { S.pairs++;
  const kx = deriveKey("cov2", i), ko = deriveKey("cov2", i + 1); const c = Array(9).fill(0); c[4] = 1;
  const st1 = { px: kx.toKeypair().xOnlyPublicKey, po: ko.toKeypair().xOnlyPublicKey, turn: 1, c }; const a = adr(st1);
  const us = await (await fetch("https://api-tn10.kaspa.org/addresses/utxos", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ addresses: [a] }) })).json();
  for (const u of us) { S.found++; appendFileSync(LOG, JSON.stringify({ pair: i, utxo: u.outpoint, daa: u.utxoEntry.blockDaaScore, amt: u.utxoEntry.amount }) + "\n"); const amt = BigInt(u.utxoEntry.amount);
    const inp = { address: a, outpoint: u.outpoint, sequence: 100n, sigOpCount: 4, utxoEntry: { amount: amt, scriptPublicKey: spk(st1), blockDaaScore: BigInt(u.utxoEntry.blockDaaScore), isCoinbase: false } };
    const mk = (fee) => { const tx = kaspa.createTransaction([inp], [{ address: addrOf(kx), amount: amt - fee }], 0n, null, 4); tx.inputs[0].sequence = 100n; const sg = kaspa.createInputSignature(tx, 0, kx).slice(2); const sb = new kaspa.ScriptBuilder(); sb.addData(sg); sb.addData(TAG); sb.addData(red(st1)); tx.inputs[0].signatureScript = sb.drain(); tx.finalize(); return tx; }; // r7: finalize() refreshes the cached id after sequence/sigscript edits
    const t = mk(BigInt(kaspa.calculateTransactionMass(NET, mk(0n))) * fr);
    try { await rpc.submitTransaction({ transaction: t, allowOrphan: false });
      const out = t.outputs[0].value; await new Promise((r) => setTimeout(r, 1500));
      let sw = kaspa.createTransaction([{ address: addrOf(kx), outpoint: { transactionId: t.id, index: 0 }, utxoEntry: { amount: out, scriptPublicKey: kaspa.payToAddressScript(addrOf(kx)), blockDaaScore: 0n, isCoinbase: false } }], [{ address: FA, amount: out - 1000000n }], 0n, null, 1); kaspa.signTransaction(sw, [kx], false);
      await rpc.submitTransaction({ transaction: sw, allowOrphan: false }); S.recovered++; S.tkas += Number(amt) / 1e8; appendFileSync(LOG, JSON.stringify({ pair: i, timeout: t.id, sweep: sw.id }) + "\n");
    } catch (e) { S.fail.push(String(e.message || e).replace(/[0-9a-f]{64}/g, "<h>").slice(0, 160)); } } }
appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), ...S }) + "\n"); console.log(JSON.stringify(S)); process.exit(0);
