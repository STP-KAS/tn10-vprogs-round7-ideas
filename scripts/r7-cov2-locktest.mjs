// r7: does an early CovTTT2 timeout (sequence=TTL, script this.ageDaa>=TTL) get ACCEPTED before the lock matures?
// Measures on our own n0: accepting chain block (virtual-chain-changed) -> getBlock -> daaScore for move and timeout.
import { readFileSync, writeFileSync, appendFileSync, existsSync, renameSync } from "node:fs";
import { kaspa, NET, deskKey, addrOf, connect } from "./lib.mjs";
import { deriveKey } from "./r7-engine.mjs";
const D = "/workspace/tn10-break-test-2026-09-25"; const LOG = `${D}/logs/round7/cov2-locktest.jsonl`;
const log = (o) => { const s = JSON.stringify({ t: new Date().toISOString(), ...o }, (k, v) => typeof v === "bigint" ? v.toString() : v); appendFileSync(LOG, s + "\n"); console.log(s); };
const ART = JSON.parse(readFileSync(`${D}/covenants/covttt2.json`, "utf8")).contracts.CovTTT2; const BC = Buffer.from(ART.compiled.bytecode); const SP = ART.compiled.state_span;
const PRE = BC.subarray(0, SP.offset).toString("hex"), SUF = BC.subarray(SP.offset + SP.len).toString("hex"); const TAGS = Object.fromEntries(Object.entries(ART.entries).map(([k, v]) => [k, v.dispatch_tag]));
const i64 = (v) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v)); return "08" + b.toString("hex"); };
const TTL = BigInt(process.argv[2] || 100), MAXFEE = 10000000n, SEQ = BigInt(process.argv[3] ?? process.argv[2] ?? 100);
const enc = (s) => "20" + s.px + "20" + s.po + i64(s.turn) + s.c.map(i64).join("") + i64(MAXFEE) + i64(TTL);
const red = (s) => PRE + enc(s) + SUF; const spk = (s) => kaspa.payToScriptHashScript(red(s)); const adr = (s) => kaspa.addressFromScriptPublicKey(spk(s), NET).toString();
const fr = () => BigInt(readFileSync("/tmp/r6-feerate", "utf8").trim());
const FK = deskKey(0), FA = addrOf(FK), FS = kaspa.payToAddressScript(FA); const rpc = await connect("n0");
const acc = new Map(); rpc.addEventListener("virtual-chain-changed", (e) => { for (const a of e.data.acceptedTransactionIds) for (const id of a.acceptedTransactionIds) if (!acc.has(id)) acc.set(id, a.acceptingBlockHash); }); await rpc.subscribeVirtualChainChanged(true);
const daaOf = async (h) => { const b = await rpc.getBlock({ hash: h, includeTransactions: false }); return BigInt(b.block.header.daaScore); };
const CF = "/home/box/secure/r7-keyctr-cov2.txt"; const nextKey = () => { const n = existsSync(CF) ? Number(readFileSync(CF, "utf8")) : 0; writeFileSync(CF + ".tmp", String(n + 1), { mode: 0o600 }); renameSync(CF + ".tmp", CF); return deriveKey("cov2", n); };
const USEDF = "/workspace/tmp/r7-cov-used.txt"; const USED = new Set(existsSync(USEDF) ? readFileSync(USEDF, "utf8").split("\n") : []);
const raw = JSON.parse(readFileSync("/tmp/r5-reserved-utxos.json", "utf8")).filter((u) => parseInt(u.outpoint.transactionId.slice(8, 16), 16) % 4 === 2 && !USED.has(u.outpoint.transactionId + ":" + u.outpoint.index)).sort((a, b) => Number(BigInt(b.utxoEntry.amount) - BigInt(a.utxoEntry.amount)));
const ss = []; let tot = 0n; for (const u of raw) { ss.push(u); tot += BigInt(u.utxoEntry.amount); if (tot >= 200000000n) break; } for (const u of ss) appendFileSync(USEDF, u.outpoint.transactionId + ":" + u.outpoint.index + "\n");
const sub = async (tx) => { try { await rpc.submitTransaction({ transaction: tx, allowOrphan: false }); return { ok: true }; } catch (e) { return { ok: false, e: String(e.message || e).replace(/[0-9a-f]{64}/g, "<h>").slice(0, 220) }; } };
function spend(st, op, entry, outs, signer, seq) {
  const inp = { address: adr(st), outpoint: op.outpoint, sequence: seq, sigOpCount: 4, utxoEntry: { amount: op.amount, scriptPublicKey: spk(st), blockDaaScore: 0n, isCoinbase: false } };
  const mk = (fee) => { const tx = kaspa.createTransaction([inp], outs(fee), 0n, null, 4); tx.inputs[0].sequence = seq; const sg = kaspa.createInputSignature(tx, 0, signer).slice(2); const sb = new kaspa.ScriptBuilder(); sb.addData(sg); sb.addData(TAGS[entry]); sb.addData(red(st)); tx.inputs[0].signatureScript = sb.drain(); tx.finalize(); return tx; }; // r7: finalize() refreshes the cached id after sequence/sigscript edits
  return mk(BigInt(kaspa.calculateTransactionMass(NET, mk(0n))) * fr()); }
const kx = nextKey(), ko = nextKey(); const st0 = { px: kx.toKeypair().xOnlyPublicKey, po: ko.toKeypair().xOnlyPublicKey, turn: 0, c: Array(9).fill(0) };
const ins = ss.map((u) => ({ address: FA, outpoint: u.outpoint, utxoEntry: { amount: BigInt(u.utxoEntry.amount), scriptPublicKey: FS, blockDaaScore: BigInt(u.utxoEntry.blockDaaScore), isCoinbase: u.utxoEntry.isCoinbase } }));
let f = kaspa.createTransaction(ins, [{ address: adr(st0), amount: tot - 1n }], 0n, null, 1); kaspa.signTransaction(f, [FK], false);
f = kaspa.createTransaction(ins, [{ address: adr(st0), amount: tot - BigInt(kaspa.calculateTransactionMass(NET, f)) * fr() }], 0n, null, 1); kaspa.signTransaction(f, [FK], false);
log({ ev: "fund", ...(await sub(f)), id: f.id, ttl: TTL, seq: SEQ }); let op = { outpoint: { transactionId: f.id, index: 0 }, amount: f.outputs[0].value };
const st1 = { ...st0, turn: 1, c: st0.c.map((v, j) => (j === 4 ? 1 : v)) };
const mv = spend(st0, op, "move", (fee) => [{ address: adr(st1), amount: op.amount - fee }], kx, 0n); // move arg: cell pushed below
{ // rebuild move with cell arg
  const inp = { address: adr(st0), outpoint: op.outpoint, sequence: 0n, sigOpCount: 4, utxoEntry: { amount: op.amount, scriptPublicKey: spk(st0), blockDaaScore: 0n, isCoinbase: false } };
  const mk = (fee) => { const tx = kaspa.createTransaction([inp], [{ address: adr(st1), amount: op.amount - fee }], 0n, null, 4); const sg = kaspa.createInputSignature(tx, 0, kx).slice(2); const sb = new kaspa.ScriptBuilder(); sb.addData(sg); sb.addI64(4n); sb.addData(TAGS.move); sb.addData(red(st0)); tx.inputs[0].signatureScript = sb.drain(); tx.finalize(); return tx; }; // r7: finalize() refreshes the cached id after sequence/sigscript edits
  var move = mk(BigInt(kaspa.calculateTransactionMass(NET, mk(0n))) * fr()); }
// wait until funding is accepted so the move's input has a real DAA
for (let a = 0; a < 60 && !acc.has(f.id); a++) await new Promise((r) => setTimeout(r, 500));
log({ ev: "move_submit", ...(await sub(move)), id: move.id }); op = { outpoint: { transactionId: move.id, index: 0 }, amount: move.outputs[0].value };
const CHAINED = process.env.CHAINED === "1"; if (!CHAINED) for (let a = 0; a < 60 && !acc.has(move.id); a++) await new Promise((r) => setTimeout(r, 250));
let moveDaa = acc.has(move.id) ? await daaOf(acc.get(move.id)) : null; log({ ev: "move_accepted", daa: moveDaa, chained: CHAINED });
const early = spend(st1, op, "timeout", (fee) => [{ address: addrOf(kx), amount: op.amount - fee }], kx, SEQ);
const r = await sub(early); const vd0 = BigInt((await rpc.getBlockDagInfo()).virtualDaaScore); log({ ev: "early_timeout_submit", ...r, id: early.id, virtual_daa: vd0, age_at_submit: moveDaa ? vd0 - moveDaa : null });
let tDaa = null; for (let a = 0; a < 240; a++) { await new Promise((r2) => setTimeout(r2, 500)); if (!moveDaa && acc.has(move.id)) moveDaa = await daaOf(acc.get(move.id)); if (acc.has(early.id)) { tDaa = await daaOf(acc.get(early.id)); if (!moveDaa && acc.has(move.id)) moveDaa = await daaOf(acc.get(move.id)); break; } if (!r.ok) break; }
const inMp = await rpc.getMempoolEntry({ transactionId: early.id, includeOrphanPool: true, filterTransactionPool: false }).then(() => true).catch(() => false); log({ ev: "early_still_in_mempool", inMp });
log({ ev: "result", timeout_accepted_daa: tDaa, move_daa: moveDaa, age_at_acceptance: tDaa && moveDaa ? tDaa - moveDaa : null, ttl: TTL, verdict: tDaa == null ? (r.ok ? "not accepted within 120 s" : "rejected at submit") : (tDaa - moveDaa >= TTL ? "OK: accepted only after ttl" : "BUG: accepted before ttl") });
if (tDaa) { let sw = kaspa.createTransaction([{ address: addrOf(kx), outpoint: { transactionId: early.id, index: 0 }, utxoEntry: { amount: early.outputs[0].value, scriptPublicKey: kaspa.payToAddressScript(addrOf(kx)), blockDaaScore: 0n, isCoinbase: false } }], [{ address: FA, amount: early.outputs[0].value - 1000000n }], 0n, null, 1); kaspa.signTransaction(sw, [kx], false); log({ ev: "sweep", ...(await sub(sw)) }); }
process.exit(0);
