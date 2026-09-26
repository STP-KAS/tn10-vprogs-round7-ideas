// r7 CovTTT2 liveness test (TN10): N games; X moves once, O stalls. Probes: (a) X tries timeout (wrong waiter) -> reject,
// (b) O-side waiter X... precisely: after X moved it is O's turn, so the WAITER is X. (b) X claims timeout BEFORE ttl -> reject,
// (c) after ttl DAA, X claims timeout -> accept. Pot swept back to faucet. Keys derived + counter persisted before funding.
import { readFileSync, writeFileSync, appendFileSync, existsSync, renameSync } from "node:fs";
import { kaspa, NET, deskKey, addrOf, connect } from "./lib.mjs";
import { deriveKey } from "./r7-engine.mjs";
const D = "/workspace/tn10-break-test-2026-09-25"; const LOG = `${D}/logs/round7/covttt2-timeout.jsonl`; const N = Number(process.argv[2] || 5);
const log = (o) => { const s = JSON.stringify({ t: new Date().toISOString(), ...o }, (k, v) => typeof v === "bigint" ? v.toString() : v); appendFileSync(LOG, s + "\n"); console.log(s); };
const ART = JSON.parse(readFileSync(`${D}/covenants/covttt2.json`, "utf8")).contracts.CovTTT2; const BC = Buffer.from(ART.compiled.bytecode); const SP = ART.compiled.state_span;
const PRE = BC.subarray(0, SP.offset).toString("hex"), SUF = BC.subarray(SP.offset + SP.len).toString("hex"); const TAGS = Object.fromEntries(Object.entries(ART.entries).map(([k, v]) => [k, v.dispatch_tag]));
const i64 = (v) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v)); return "08" + b.toString("hex"); };
const TTL = 100n, MAXFEE = 10000000n;
const enc = (s) => "20" + s.px + "20" + s.po + i64(s.turn) + s.c.map(i64).join("") + i64(MAXFEE) + i64(TTL);
if (PRE + enc({ px: "11".repeat(32), po: "22".repeat(32), turn: 0, c: Array(9).fill(0) }) + SUF !== BC.toString("hex")) throw new Error("encoder mismatch");
const red = (s) => PRE + enc(s) + SUF; const spk = (s) => kaspa.payToScriptHashScript(red(s)); const adr = (s) => kaspa.addressFromScriptPublicKey(spk(s), NET).toString();
const fr = () => BigInt(readFileSync("/tmp/r6-feerate", "utf8").trim());
const FK = deskKey(0), FA = addrOf(FK), FS = kaspa.payToAddressScript(FA); const rpc = await connect("n0");
const CF = "/home/box/secure/r7-keyctr-cov2.txt"; const nextKey = () => { const n = existsSync(CF) ? Number(readFileSync(CF, "utf8")) : 0; writeFileSync(CF + ".tmp", String(n + 1), { mode: 0o600 }); renameSync(CF + ".tmp", CF); return deriveKey("cov2", n); };
const USEDF = "/workspace/tmp/r7-cov-used.txt"; const USED = new Set(existsSync(USEDF) ? readFileSync(USEDF, "utf8").split("\n") : []);
function seeds(want) { const raw = JSON.parse(readFileSync("/tmp/r5-reserved-utxos.json", "utf8")).filter((u) => parseInt(u.outpoint.transactionId.slice(8, 16), 16) % 4 === 2 && !USED.has(u.outpoint.transactionId + ":" + u.outpoint.index)).sort((a, b) => Number(BigInt(b.utxoEntry.amount) - BigInt(a.utxoEntry.amount)));
  const o = []; let s = 0n; for (const u of raw) { o.push(u); s += BigInt(u.utxoEntry.amount); if (s >= want) break; } for (const u of o) { const k = u.outpoint.transactionId + ":" + u.outpoint.index; USED.add(k); appendFileSync(USEDF, k + "\n"); } return o; }
const sub = async (tx) => { try { await rpc.submitTransaction({ transaction: tx, allowOrphan: false }); return { ok: true, id: tx.id }; } catch (e) { return { ok: false, e: String(e.message || e).replace(/[0-9a-f]{64}/g, "<h>").slice(0, 200) }; } };
function spend(st, op, entry, args, outs, signer, seq = 0n) {
  const inp = { address: adr(st), outpoint: op.outpoint, sequence: seq, sigOpCount: 4, utxoEntry: { amount: op.amount, scriptPublicKey: spk(st), blockDaaScore: 0n, isCoinbase: false } };
  const mk = (fee) => { const tx = kaspa.createTransaction([inp], outs(fee), 0n, null, 4); tx.inputs[0].sequence = seq;
    const sg = kaspa.createInputSignature(tx, 0, signer).slice(2); const sb = new kaspa.ScriptBuilder(); sb.addData(sg); args(sb); sb.addData(TAGS[entry]); sb.addData(red(st)); tx.inputs[0].signatureScript = sb.drain(); tx.finalize(); return tx; }; // r7: finalize() refreshes the cached id after sequence/sigscript edits
  const m = BigInt(kaspa.calculateTransactionMass(NET, mk(0n))); return mk(m * fr()); }
const R = { games: 0, early_rejected: 0, wrong_waiter_rejected: 0, timeout_ok: 0, ILLEGAL_ACCEPTED: 0, wait_ms: [] };
for (let g = 0; g < N; g++) {
  const kx = nextKey(), ko = nextKey(); const st0 = { px: kx.toKeypair().xOnlyPublicKey, po: ko.toKeypair().xOnlyPublicKey, turn: 0, c: Array(9).fill(0) };
  const ss = seeds(200000000n); const ins = ss.map((u) => ({ address: FA, outpoint: u.outpoint, utxoEntry: { amount: BigInt(u.utxoEntry.amount), scriptPublicKey: FS, blockDaaScore: BigInt(u.utxoEntry.blockDaaScore), isCoinbase: u.utxoEntry.isCoinbase } }));
  const tot = ins.reduce((a, x) => a + x.utxoEntry.amount, 0n); let f = kaspa.createTransaction(ins, [{ address: adr(st0), amount: tot - 1n }], 0n, null, 1); kaspa.signTransaction(f, [FK], false);
  f = kaspa.createTransaction(ins, [{ address: adr(st0), amount: tot - BigInt(kaspa.calculateTransactionMass(NET, f)) * fr() }], 0n, null, 1); kaspa.signTransaction(f, [FK], false);
  const fr0 = await sub(f); if (!fr0.ok) { log({ ev: "fund_fail", ...fr0 }); continue; } let op = { outpoint: { transactionId: f.id, index: 0 }, amount: f.outputs[0].value };
  const st1 = { ...st0, turn: 1, c: st0.c.map((v, j) => (j === 4 ? 1 : v)) };
  const mv = spend(st0, op, "move", (sb) => sb.addI64(4n), (fee) => [{ address: adr(st1), amount: op.amount - fee }], kx); const r1 = await sub(mv); if (!r1.ok) { log({ ev: "move_fail", ...r1 }); continue; }
  op = { outpoint: { transactionId: mv.id, index: 0 }, amount: mv.outputs[0].value }; R.games++; const tMove = Date.now();
  const payX = (fee) => [{ address: addrOf(kx), amount: op.amount - fee }];
  const earlyTx = spend(st1, op, "timeout", () => {}, payX, kx, TTL); const early = await sub(earlyTx);
  if (early.ok) { R.early_mempool_accepted = (R.early_mempool_accepted || 0) + 1; log({ ev: "EARLY_TIMEOUT_MEMPOOL_ACCEPTED", fund: f.id, move: mv.id, timeout: earlyTx.id, submit_ms: Date.now() });
    // does it get MINED before ttl DAA? poll the public API for both accepting DAA scores
    const q = async (id) => { try { const j = await (await fetch(`https://api-tn10.kaspa.org/transactions/${id}?resolve_previous_outpoints=no`, { signal: AbortSignal.timeout(20000) })).json(); return { daa: j.accepting_block_blue_score ?? null, acc: j.is_accepted, bt: j.accepting_block_time ?? j.block_time ?? null }; } catch (e) { return { err: String(e).slice(0, 80) }; } };
    for (let a = 0; a < 40; a++) { await new Promise((r) => setTimeout(r, 3000)); const A = await q(mv.id), B = await q(earlyTx.id); if (a % 5 === 0 || (A.acc && B.acc)) log({ ev: "poll", a, move: A, timeout: B }); if (A.acc && B.acc) break; }
    const sw = kaspa.createTransaction([{ address: addrOf(kx), outpoint: { transactionId: earlyTx.id, index: 0 }, utxoEntry: { amount: earlyTx.outputs[0].value, scriptPublicKey: kaspa.payToAddressScript(addrOf(kx)), blockDaaScore: 0n, isCoinbase: false } }], [{ address: FA, amount: earlyTx.outputs[0].value - 1000000n }], 0n, null, 1); kaspa.signTransaction(sw, [kx], false); log({ ev: "sweep", ...(await sub(sw)) });
    continue; }
  R.early_rejected++;
  const wrong = await sub(spend(st1, op, "timeout", () => {}, (fee) => [{ address: addrOf(ko), amount: op.amount - fee }], ko, TTL)); if (wrong.ok) { R.ILLEGAL_ACCEPTED++; log({ ev: "ILLEGAL_ACCEPTED", kind: "wrong_waiter" }); continue; } R.wrong_waiter_rejected++;
  if (g === 0) log({ ev: "probe_errs", early: early.e, wrong: wrong.e });
  let done = null; for (let a = 0; a < 90 && !done; a++) { await new Promise((r) => setTimeout(r, 2000)); const tx = spend(st1, op, "timeout", () => {}, payX, kx, TTL); const r = await sub(tx); if (r.ok) done = tx; else if (a % 10 === 0) log({ ev: "wait", a, e: r.e }); }
  if (!done) { log({ ev: "timeout_never_ok", game: g }); continue; }
  R.timeout_ok++; R.wait_ms.push(Date.now() - tMove);
  let sw = kaspa.createTransaction([{ address: addrOf(kx), outpoint: { transactionId: done.id, index: 0 }, utxoEntry: { amount: done.outputs[0].value, scriptPublicKey: kaspa.payToAddressScript(addrOf(kx)), blockDaaScore: 0n, isCoinbase: false } }], [{ address: FA, amount: done.outputs[0].value - 1000000n }], 0n, null, 1); kaspa.signTransaction(sw, [kx], false); await sub(sw);
  log({ ev: "game", g, fund: f.id, move: mv.id, timeout: done.id, wait_ms: Date.now() - tMove });
}
log({ ev: "summary", ...R }); process.exit(0);
