// round7 CovTTT driver (TN10 only): tic-tac-toe where the RULES ARE ENFORCED BY L1 SCRIPT (SilverScript v1.0.0 covenant,
// covenants/covttt.sil), not by this client. Each game = one covenant UTXO holding the pot; each move spends it and must
// recreate it with the exact next state (validateOutputState) and value >= in - maxFee. Winner claims to own P2PK, draw splits.
// Index-free: we built every output, so we always know the current outpoint. Keys are DERIVED (sha256(seed|tag|i)), counter
// persisted before funding. Adversarial probes: illegal spends are SUBMITTED to n0 and must be REJECTED by consensus.
import crypto from "node:crypto";
import { readFileSync, writeFileSync, appendFileSync, existsSync, renameSync } from "node:fs";
import { kaspa, NET, deskKey, addrOf } from "./lib.mjs";
import { Engine, deriveKey, setKeyTag, halted, sleep, feerate, DIR } from "./r7-engine.mjs";
const TAG = process.argv[2] || "C1"; const CONC = Number(process.env.COV_CONC || 4); const POT = BigInt(Math.round(Number(process.env.COV_POT_TKAS || 4) * 1e8));
const PROBE = Number(process.env.COV_PROBE || 3); const MAXGAMES = Number(process.env.COV_MAXGAMES || 1e12);
const LOG = `${DIR}/logs/round7/covttt-${TAG}.jsonl`; const log = (o) => appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), ...o }, (k, v) => typeof v === "bigint" ? v.toString() : v) + "\n");
const ART = JSON.parse(readFileSync(`${DIR}/covenants/covttt.json`, "utf8")).contracts.CovTTT;
const BC = Buffer.from(ART.compiled.bytecode); const SP = ART.compiled.state_span; // {offset:1,len:165}
const PREFIX = BC.subarray(0, SP.offset).toString("hex"), SUFFIX = BC.subarray(SP.offset + SP.len).toString("hex");
const TAGS = Object.fromEntries(Object.entries(ART.entries).map(([k, v]) => [k, v.dispatch_tag]));
const MAXFEE = BigInt(process.env.COV_MAXFEE || 10000000); // 0.1 TKAS per move allowance, baked into the covenant state
const i64 = (v) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v)); return "08" + b.toString("hex"); };
const encState = (s) => "20" + s.px + "20" + s.po + i64(s.turn) + s.c.map(i64).join("") + i64(s.maxFee);
const redeemOf = (s) => PREFIX + encState(s) + SUFFIX;
const spkOf = (s) => kaspa.payToScriptHashScript(redeemOf(s));
const addrOfSpk = (spk) => kaspa.addressFromScriptPublicKey(spk, NET).toString();
if (redeemOf({ px: "11".repeat(32), po: "22".repeat(32), turn: 0, c: Array(9).fill(0), maxFee: 100000n }) !== BC.toString("hex")) throw new Error("state encoder mismatch vs compiled artifact");
const WINS = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
const winner = (c) => { for (const [a, b, d] of WINS) if (c[a] && c[a] === c[b] && c[b] === c[d]) return c[a]; return 0; };
const FKEY = deskKey(0); const FADDR = addrOf(FKEY); const FSPK = kaspa.payToAddressScript(FADDR);
setKeyTag("cov-" + TAG);
// ---- funding seeds: faucet slice txid[8:16] % 4 == 2 (reserved for covenant prototypes) ----
const USEDF = "/workspace/tmp/r7-cov-used.txt"; const USED = new Set(existsSync(USEDF) ? readFileSync(USEDF, "utf8").split("\n").filter(Boolean) : []);
function takeSeeds(want) {
  let raw = []; try { raw = JSON.parse(readFileSync("/tmp/r5-reserved-utxos.json", "utf8")); } catch { return null; }
  const c = raw.filter((u) => parseInt(u.outpoint.transactionId.slice(8, 16), 16) % 4 === 2 && !USED.has(u.outpoint.transactionId + ":" + u.outpoint.index))
    .sort((a, b) => Number(BigInt(b.utxoEntry.amount) - BigInt(a.utxoEntry.amount)));
  const out = []; let sum = 0n; for (const u of c) { out.push(u); sum += BigInt(u.utxoEntry.amount); if (sum >= want || out.length >= 20) break; }
  if (sum < want) return null; for (const u of out) { const k = u.outpoint.transactionId + ":" + u.outpoint.index; USED.add(k); appendFileSync(USEDF, k + "\n"); } return out;
}
// ---- persisted game registry (key indices + current outpoint + state), so an interrupted game can be finished later ----
const GF = `/home/box/secure/r7-cov-games-${TAG}.json`; const GAMES = new Map();
const saveGames = () => { writeFileSync(GF + ".tmp", JSON.stringify([...GAMES.values()], (k, v) => typeof v === "bigint" ? v.toString() : v), { mode: 0o600 }); renameSync(GF + ".tmp", GF); };
setInterval(() => saveGames2(), 3000);
const S = { games: 0, wins_x: 0, wins_o: 0, draws: 0, moves: 0, claims: 0, sweeps: 0, fund_fail: 0, move_fail: 0, probes: 0, probes_rejected: 0, ILLEGAL_ACCEPTED: 0, by_probe: {}, probe_errs: {}, mass: [], fee_sompi: 0n };
const eng = new Engine(`cov-${TAG}`); await eng.connect(); eng.startGuards(process.env.RATEFILE || "/tmp/r7-cov.rate");
const rpc = eng.rpc;
function covInput(g) { return { address: addrOfSpk(spkOf(g.st)), outpoint: { transactionId: g.txid, index: g.index }, utxoEntry: { amount: g.amount, scriptPublicKey: spkOf(g.st), blockDaaScore: 0n, isCoinbase: false } }; }
// build a spend of the covenant: entry + args, outputs; signer key; returns {tx, fee, mass}
const SIGOPS = Number(process.env.COV_SIGOPS || 4);
function buildSpend(g, entry, argsFn, outsFn, signer, sigops = SIGOPS) {
  const inp = covInput(g); const redeem = redeemOf(g.st);
  const mk = (fee) => { const tx = kaspa.createTransaction([inp], outsFn(fee), 0n, null, sigops);
    const sig = kaspa.createInputSignature(tx, 0, signer).slice(2); /* SDK returns 0x41-prefixed push; covenant arg wants the raw 65 bytes */ const sb = new kaspa.ScriptBuilder(); sb.addData(sig); argsFn(sb); sb.addData(TAGS[entry]); sb.addData(redeem);
    tx.inputs[0].signatureScript = sb.drain(); return tx; };
  let tx = mk(0n); const mass = BigInt(kaspa.calculateTransactionMass(NET, tx)); const fee = mass * feerate(); tx = mk(fee);
  return { tx, fee, mass };
}
const moveOut = (g, ns, fee, extra = 0n) => [{ address: addrOfSpk(spkOf(ns)), amount: g.amount - fee - extra }];
async function probe(kind, g, ok) { // submit an ILLEGAL spend; consensus must reject it
  S.probes++; S.by_probe[kind] = (S.by_probe[kind] || 0) + 1;
  try { await rpc.submitTransaction({ transaction: ok.tx, allowOrphan: false }); S.ILLEGAL_ACCEPTED++; log({ ev: "ILLEGAL_ACCEPTED", kind, txid: ok.tx.id, game: g.id }); return true; }
  catch (e) { S.probes_rejected++; const m = String(e.message || e).replace(/[0-9a-f]{64}/g, "<h>").replace(/Rejected transaction <h>: /, "").replace(/used=\d+/, "used=N").slice(0, 220); if (/units exceeded/.test(String(e))) log({ ev: "units", kind, e: String(e.message || e).slice(0, 400) }); const k = kind + ": " + m; S.probe_errs[k] = (S.probe_errs[k] || 0) + 1; return false; }
}
function legalCells(c) { return c.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0); }
const RESUME = (() => { try { return JSON.parse(readFileSync(GF, "utf8")).map((g) => ({ ...g, amount: BigInt(g.amount), st: { ...g.st, maxFee: BigInt(g.st.maxFee) } })); } catch { return []; } })();
// RESCUE (index-free recovery): every game's genesis covenant address is a pure function of (derived key pair, maxFee), so
// unresolved genesis covenants can always be found again on the public API even if the local registry is lost.
if (process.env.COV_RESCUE) {
  const f = `/home/box/secure/r7-keyctr-cov-${TAG}.txt`; const n = existsSync(f) ? Number(readFileSync(f, "utf8").trim()) : 0;
  const cands = []; for (let i = 0; i + 1 < n; i += 2) { const px = deriveKey("cov-" + TAG, i).toKeypair().xOnlyPublicKey, po = deriveKey("cov-" + TAG, i + 1).toKeypair().xOnlyPublicKey;
    const st = { px, po, turn: 0, c: Array(9).fill(0), maxFee: MAXFEE }; cands.push({ i, st, addr: addrOfSpk(spkOf(st)) }); }
  for (let k = 0; k < cands.length; k += 50) { const part = cands.slice(k, k + 50);
    const r = await fetch("https://api-tn10.kaspa.org/addresses/utxos", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ addresses: part.map((c) => c.addr) }), signal: AbortSignal.timeout(60000) });
    for (const u of await r.json()) { const c = part.find((x) => x.addr === u.address); if (!c) continue;
      if (RESUME.some((g) => g.txid === u.outpoint.transactionId && g.index === u.outpoint.index)) continue;
      RESUME.push({ id: `${TAG}-rescue-${c.i}`, kx: c.i, ko: c.i + 1, txid: u.outpoint.transactionId, index: u.outpoint.index, amount: BigInt(u.utxoEntry.amount), st: c.st, fund: u.outpoint.transactionId, moves: [] }); } }
  log({ ev: "rescue", scanned: cands.length, resume: RESUME.length });
}
const saveGames2 = () => { const all = [...GAMES.values(), ...RESUME]; writeFileSync(GF + ".tmp", JSON.stringify(all, (k, v) => typeof v === "bigint" ? v.toString() : v), { mode: 0o600 }); renameSync(GF + ".tmp", GF); };
async function playGame(lane) {
  let g, keys;
  const r = RESUME.pop();
  if (r) { g = r; keys = [deriveKey("cov-" + TAG, g.kx), deriveKey("cov-" + TAG, g.ko)]; GAMES.set(g.id, g); log({ ev: "resume", id: g.id }); }
  else {
  const i = S.games; const kx = deriveKeyNext(), ko = deriveKeyNext();
  const px = kx.key.toKeypair().xOnlyPublicKey, po = ko.key.toKeypair().xOnlyPublicKey;
  const st0 = { px, po, turn: 0, c: Array(9).fill(0), maxFee: MAXFEE };
  const seeds = takeSeeds(POT); if (!seeds) { await sleep(5000); return false; }
  const ins = seeds.map((u) => ({ address: FADDR, outpoint: u.outpoint, utxoEntry: { amount: BigInt(u.utxoEntry.amount), scriptPublicKey: FSPK, blockDaaScore: BigInt(u.utxoEntry.blockDaaScore), isCoinbase: u.utxoEntry.isCoinbase } }));
  const tot = ins.reduce((a, x) => a + x.utxoEntry.amount, 0n); const covAddr = addrOfSpk(spkOf(st0));
  let ftx = kaspa.createTransaction(ins, [{ address: covAddr, amount: tot - 1n }], 0n, null, 1); kaspa.signTransaction(ftx, [FKEY], false);
  const ffee = BigInt(kaspa.calculateTransactionMass(NET, ftx)) * feerate(); ftx = kaspa.createTransaction(ins, [{ address: covAddr, amount: tot - ffee }], 0n, null, 1); kaspa.signTransaction(ftx, [FKEY], false);
  if (!(await eng.submit({ tx: ftx, fee: ffee }))) { S.fund_fail++; return false; }
  g = { id: `${TAG}-${Date.now().toString(36)}-${lane}`, kx: kx.i, ko: ko.i, txid: ftx.id, index: 0, amount: tot - ffee, st: st0, fund: ftx.id, moves: [] };
  GAMES.set(g.id, g); S.games++; keys = [kx.key, ko.key];
  }
  for (let ply = g.st.c.filter((v) => v).length; ply < 9 && !halted(); ply++) {
    const c = g.st.c, turn = g.st.turn, me = keys[turn], other = keys[turn ^ 1], mark = turn + 1;
    const free = legalCells(c); const cell = free[crypto.randomInt(free.length)];
    const ns = { ...g.st, turn: 1 - turn, c: c.map((v, j) => (j === cell ? mark : v)) };
    if (Math.random() < 1 / PROBE) { // one illegal attempt against the live covenant
      const occ = c.map((v, j) => (v ? j : -1)).filter((j) => j >= 0); const kinds = ["wrong_signer", "cell_out_of_range", "state_tamper", "turn_not_flipped", "value_theft", "premature_claim"]; if (occ.length) kinds.push("occupied_cell");
      const kind = kinds[crypto.randomInt(kinds.length)]; let b;
      if (kind === "wrong_signer") b = buildSpend(g, "move", (sb) => sb.addI64(BigInt(cell)), (fee) => moveOut(g, ns, fee), other);
      else if (kind === "cell_out_of_range") b = buildSpend(g, "move", (sb) => sb.addI64(9n), (fee) => moveOut(g, { ...g.st, turn: 1 - turn }, fee), me);
      else if (kind === "state_tamper") { const f2 = free.filter((j) => j !== cell); const t2 = f2.length ? { ...ns, c: ns.c.map((v, j) => (j === f2[0] ? mark : v)) } : { ...ns, maxFee: MAXFEE * 100n }; b = buildSpend(g, "move", (sb) => sb.addI64(BigInt(cell)), (fee) => moveOut(g, t2, fee), me); }
      else if (kind === "turn_not_flipped") b = buildSpend(g, "move", (sb) => sb.addI64(BigInt(cell)), (fee) => moveOut(g, { ...ns, turn }, fee), me);
      else if (kind === "value_theft") b = buildSpend(g, "move", (sb) => sb.addI64(BigInt(cell)), (fee) => [...moveOut(g, ns, fee, MAXFEE + 100000000n), { address: addrOf(me), amount: 100000000n }], me);
      else if (kind === "premature_claim") b = buildSpend(g, "claim", (sb) => sb.addI64(BigInt(mark)), (fee) => [{ address: addrOf(me), amount: g.amount - fee }], me);
      else { const oc = occ[crypto.randomInt(occ.length)]; b = buildSpend(g, "move", (sb) => sb.addI64(BigInt(oc)), (fee) => moveOut(g, { ...g.st, turn: 1 - turn, c: c.map((v, j) => (j === oc ? mark : v)) }, fee), me); }
      if (await probe(kind, g, b)) return true; // covenant consumed by an illegal spend -> stop this game (logged)
    }
    const mv = buildSpend(g, "move", (sb) => sb.addI64(BigInt(cell)), (fee) => moveOut(g, ns, fee), me);
    if (!(await eng.submit(mv))) { S.move_fail++; log({ ev: "move_fail", game: g.id, ply, errs: eng.errs, mass: mv.mass }); try { await rpc.submitTransaction({ transaction: mv.tx, allowOrphan: false }); } catch (e) { log({ ev: "move_fail_detail", e: String(e.message || e).slice(0, 400) }); } return true; }
    S.moves++; S.mass.push(Number(mv.mass)); S.fee_sompi += mv.fee; g.moves.push(mv.tx.id);
    g.txid = mv.tx.id; g.index = 0; g.amount = g.amount - mv.fee; g.st = ns;
    const w = winner(ns.c);
    if (w) { // extra probe: another move after the game is decided must be refused
      const fr2 = legalCells(ns.c);
      if (fr2.length) { const cm = fr2[0]; const loserTurn = ns.turn; const nn = { ...ns, turn: 1 - loserTurn, c: ns.c.map((v, j) => (j === cm ? loserTurn + 1 : v)) };
        if (await probe("move_after_win", g, buildSpend(g, "move", (sb) => sb.addI64(BigInt(cm)), (fee) => moveOut(g, nn, fee), keys[loserTurn]))) return true; }
      const wk = keys[w - 1]; const cl = buildSpend(g, "claim", (sb) => sb.addI64(BigInt(w)), (fee) => [{ address: addrOf(wk), amount: g.amount - fee }], wk);
      if (!(await eng.submit(cl))) { S.move_fail++; log({ ev: "claim_fail", game: g.id, errs: eng.errs }); return true; }
      S.claims++; if (w === 1) S.wins_x++; else S.wins_o++; g.claim = cl.tx.id;
      await sweep([{ key: wk, txid: cl.tx.id, index: 0, amount: g.amount - cl.fee }]); g.done = true; log({ ev: "game", id: g.id, result: w === 1 ? "X" : "O", plies: ply + 1, fund: g.fund, moves: g.moves, claim: g.claim }); GAMES.delete(g.id); return true;
    }
    if (ply === 8) { // board full, no winner -> draw split (either player signs)
      const half = (g.amount - MAXFEE) / 2n;
      const dr = buildSpend(g, "draw", () => {}, (fee) => [{ address: addrOf(keys[0]), amount: (g.amount - fee) / 2n }, { address: addrOf(keys[1]), amount: (g.amount - fee) - (g.amount - fee) / 2n }], keys[0]);
      if (!(await eng.submit(dr))) { S.move_fail++; log({ ev: "draw_fail", game: g.id, errs: eng.errs, half }); return true; }
      S.draws++; g.claim = dr.tx.id; const a0 = (g.amount - dr.fee) / 2n;
      await sweep([{ key: keys[0], txid: dr.tx.id, index: 0, amount: a0 }, { key: keys[1], txid: dr.tx.id, index: 1, amount: g.amount - dr.fee - a0 }]);
      g.done = true; log({ ev: "game", id: g.id, result: "draw", plies: 9, fund: g.fund, moves: g.moves, claim: g.claim }); GAMES.delete(g.id); return true;
    }
  }
  return true;
}
async function sweep(outs) { // pay game proceeds straight back to the faucet
  const ins = outs.map((o) => ({ address: addrOf(o.key), outpoint: { transactionId: o.txid, index: o.index }, utxoEntry: { amount: o.amount, scriptPublicKey: kaspa.payToAddressScript(addrOf(o.key)), blockDaaScore: 0n, isCoinbase: false } }));
  const tot = outs.reduce((a, o) => a + o.amount, 0n); let tx = kaspa.createTransaction(ins, [{ address: FADDR, amount: tot - 1n }], 0n, null, 1); kaspa.signTransaction(tx, outs.map((o) => o.key), false);
  const fee = BigInt(kaspa.calculateTransactionMass(NET, tx)) * feerate(); tx = kaspa.createTransaction(ins, [{ address: FADDR, amount: tot - fee }], 0n, null, 1); kaspa.signTransaction(tx, outs.map((o) => o.key), false);
  if (await eng.submit({ tx, fee })) S.sweeps++; else log({ ev: "sweep_fail", errs: eng.errs });
}
let KI = null; function deriveKeyNext() { // uses r7-engine counter via a funding-less path: reserve an index, persist, derive
  const f = `/home/box/secure/r7-keyctr-cov-${TAG}.txt`; const n = existsSync(f) ? Number(readFileSync(f, "utf8").trim()) : 0;
  writeFileSync(f + ".tmp", String(n + 1), { mode: 0o600 }); renameSync(f + ".tmp", f); return { i: n, key: deriveKey("cov-" + TAG, n) };
}
log({ ev: "start", tag: TAG, conc: CONC, pot: POT, maxFee: MAXFEE, redeem_len: BC.length, template_hash: Buffer.from(ART.compiled.template_hash).toString("hex"), tags: TAGS });
const rep = setInterval(() => { const p = eng.pstats(); const m = [...S.mass].sort((a, b) => a - b);
  log({ ev: "rep", ...S, mass: undefined, mass_p50: m[m.length >> 1] || null, mass_max: m[m.length - 1] || null, fee_tkas: Number(S.fee_sompi) / 1e8, submitted: eng.submitted, accepted: eng.accepted, rejected: eng.rejected, lat_p50: p.p50, lat_p95: p.p95, lat_n: p.n, feerate: Number(feerate()), rate: eng.rate, paused: eng.paused, errs: eng.errs, open_games: GAMES.size }); }, 10000);
async function lane(id) { while (!halted() && (S.games < MAXGAMES || RESUME.length)) { try { await playGame(id); } catch (e) { log({ ev: "exc", e: String(e.stack || e).slice(0, 300) }); await sleep(2000); } } }
await Promise.all(Array.from({ length: CONC }, (_, i) => lane(i)));
saveGames2(); await sleep(12000); clearInterval(rep); const p = eng.pstats(); log({ ev: "done", ...S, mass: undefined, lat_p50: p.p50, lat_p95: p.p95, lat_n: p.n, open_games: GAMES.size }); process.exit(0);
