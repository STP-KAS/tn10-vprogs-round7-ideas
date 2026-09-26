// round5 index-free vprog-style state machines (TN10 only). Many concurrent PROGRAMS; each is a chain funded from a
// faucet seed (reserved subset 3). Every step is a 1-in-1-out tx spending the previous program output, payload =
//   "VPG1" | kind(1B) | progId(4B) | step(4B) | stateHash(32B) | state(JSON utf8)
// stateHash = sha256(prevStateHash || stateJSON) - a hash chain anyone can re-verify from payloads alone (r5-verify.py).
// Program kinds and their transition rules (checked by rule() BEFORE building a tx; illegal ones never submitted):
//   C counter:  {n}          -> {n+d}, 1<=d<=3, n+d<=CAP(30); halts at CAP.
//   E escrow:   {st,amt,by}  -> OPEN->FUNDED (amt>0) -> RELEASED|REFUNDED (terminal); by alternates buyer/seller.
//   T turn:     {turn,round} -> player turn^1, round+1 when turn wraps; ROUNDS(6) rounds then halt.
// Illegal attempts (counter jump >3, escrow RELEASED before FUNDED, turn played by wrong player) are made with prob.
// 1/ILLEGAL and must be refused -> illegal_executed stays 0.
import crypto from "node:crypto";
import { appendFileSync } from "node:fs";
import { kaspa, addrOf } from "./lib.mjs";
import { releaseSeeds, feerate, saveChains, loadChains, setKeyTag, Engine, takeSeeds, fundChain, buildMove, halted, sleep, DIR } from "./r7-engine.mjs";

const TAG = process.argv[2] || "A";
const CONC = Number(process.env.VP_CONC || 40), ILLEGAL = Number(process.env.VP_ILLEGAL || 5);
const FUND = BigInt(Math.round(Number(process.env.VP_FUND_TKAS || 10) * 1e8));
const LOG = `${DIR}/logs/round7/vprog-${TAG}.jsonl`;
const log = (o) => appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), ...o }) + "\n");
const CAP = 30, ROUNDS = 6;

function rule(kind, s, n) { // returns null if s->n is a legal transition, else reason
  if (kind === "C") { const d = n.n - s.n; if (!(Number.isInteger(d) && d >= 1 && d <= 3)) return "counter-step"; if (n.n > CAP) return "counter-cap"; return null; }
  if (kind === "E") {
    const ok = { OPEN: ["FUNDED"], FUNDED: ["RELEASED", "REFUNDED"] }[s.st] || [];
    if (!ok.includes(n.st)) return `escrow-${s.st}->${n.st}`;
    if (n.st === "FUNDED" && !(n.amt > 0)) return "escrow-amt"; if (n.st !== "FUNDED" && n.amt !== s.amt) return "escrow-amt-change";
    if (n.by === s.by) return "escrow-same-actor"; return null; }
  if (kind === "T") { if (n.turn !== (s.turn ^ 1)) return "turn-wrong-player"; const r = s.round + (s.turn === 1 ? 1 : 0); if (n.round !== r) return "turn-round"; return null; }
  return "kind";
}
const terminal = (kind, s) => kind === "C" ? s.n >= CAP : kind === "E" ? (s.st === "RELEASED" || s.st === "REFUNDED") : s.round >= ROUNDS;
const init = (kind) => kind === "C" ? { n: 0 } : kind === "E" ? { st: "OPEN", amt: 0, by: "B" } : { turn: 0, round: 0 };
function next(kind, s) {
  if (kind === "C") return { n: Math.min(CAP, s.n + 1 + ((Math.random() * 3) | 0)) };
  if (kind === "E") { if (s.st === "OPEN") return { st: "FUNDED", amt: 1 + ((Math.random() * 1000) | 0), by: "S" }; return { st: Math.random() < 0.8 ? "RELEASED" : "REFUNDED", amt: s.amt, by: "B" }; }
  return { turn: s.turn ^ 1, round: s.round + (s.turn === 1 ? 1 : 0) };
}
function badNext(kind, s) {
  if (kind === "C") return { n: s.n + 5 + ((Math.random() * 10) | 0) };
  if (kind === "E") return s.st === "OPEN" ? { st: "RELEASED", amt: 0, by: "S" } : { st: "OPEN", amt: s.amt, by: s.by === "B" ? "S" : "B" };
  return { turn: s.turn, round: s.round + 1 };
}
const sha = (b) => crypto.createHash("sha256").update(b).digest();
const u32 = (n) => Buffer.from(Uint32Array.of(n).buffer).toString("hex");
const pl = (kind, pid, step, h, st) => Buffer.from("VPG1" + kind).toString("hex") + u32(pid) + u32(step) + h.toString("hex") + Buffer.from(JSON.stringify(st)).toString("hex");

const S = { programs_started: 0, programs_halted: 0, steps: 0, by_kind: { C: 0, E: 0, T: 0 }, illegal_attempts: 0, illegal_refused: 0, illegal_executed: 0, fund_fail: 0, prog_fail: 0, no_seed: 0 };
let pidc = crypto.randomBytes(2).readUInt16BE(0) << 12;
async function runProgram(eng, start, onMove) {  // genesis step spends the recycled chain output; returns chain end or null
  const kind = ["C", "E", "T"][(Math.random() * 3) | 0]; const pid = pidc++ >>> 0;
  let st = init(kind); let h = sha(Buffer.from("genesis" + kind + pid + JSON.stringify(st)));
  const k0 = start.key; // r7: reuse derived chain key
  const g = buildMove(start, start.key, start.address, pl(kind, pid, 0, h, st)); if (!g) { S.chain_low = (S.chain_low || 0) + 1; return null; }
  if (!(await eng.submit(g))) { S.prog_fail++; return null; }
  S.programs_started++; let cur = { ...g.out, key: k0 }, step = 1; onMove(cur);
  while (!halted() && !terminal(kind, st)) {
    if (Math.random() < 1 / ILLEGAL) { S.illegal_attempts++; const b = badNext(kind, st);
      if (rule(kind, st, b)) S.illegal_refused++; else { S.illegal_executed++; log({ ev: "ILLEGAL_EXECUTED", kind, st, b }); } }
    const n = next(kind, st); if (rule(kind, st, n)) { S.prog_fail++; log({ ev: "rule-bug", kind, st, n }); return null; }
    const nh = sha(Buffer.concat([h, Buffer.from(JSON.stringify(n))]));
    const fresh = cur.key;
    const mv = buildMove(cur, cur.key, cur.address, pl(kind, pid, step, nh, n));
    if (!mv) { S.chain_low = (S.chain_low || 0) + 1; return null; }
    if (!(await eng.submit(mv))) { S.prog_fail++; return null; }
    S.steps++; S.by_kind[kind]++; st = n; h = nh; step++; cur = { ...mv.out, key: fresh }; onMove(cur);
  }
  if (terminal(kind, st)) S.programs_halted++;
  return cur;
}
setKeyTag("vprog-" + TAG); const eng = new Engine(`vprog-${TAG}`); await eng.connect(); eng.startGuards(process.env.RATEFILE || "/tmp/r5-vprog.rate");
log({ ev: "start", tag: TAG, conc: CONC, feerate: process.env.FEERATE });
const LIVE = new Map(); let laneN = 0; const RESUME = loadChains(TAG); log({ ev: "resume", chains: RESUME.length });
setInterval(() => { try { saveChains(TAG, LIVE); } catch (e) { log({ ev: "save-err", e: String(e).slice(0, 120) }); } }, 5000);
async function lane() { const id = laneN++; let cur = RESUME.pop() || null;
  while (!halted()) {
    if (!cur) { const seeds = takeSeeds(3, FUND); if (!seeds) { S.no_seed++; await sleep(3000); continue; }
      const f = fundChain(seeds, Buffer.from("VPG1fund").toString("hex")); if (!f || !(await eng.submit(f))) { S.fund_fail++; releaseSeeds(seeds); await sleep(1000); continue; }
      S.chains_funded = (S.chains_funded || 0) + 1; cur = f.out; LIVE.set(id, cur); }
    try { cur = await runProgram(eng, cur, (c) => LIVE.set(id, c)); } catch (e) { cur = null; S.prog_fail++; log({ ev: "exc", e: String(e).slice(0, 200) }); }
    LIVE.set(id, cur);
  } }
const rep = setInterval(() => { const p = eng.pstats(); log({ ev: "rep", ...S, feerate: Number(feerate()), rate: eng.rate, paused: eng.paused, mp: eng.mp, retries: eng.retries || 0, resume_stale: eng.resume_stale || 0, submitted: eng.submitted, accepted: eng.accepted, rejected: eng.rejected,
  lat_p50: p.p50, lat_p95: p.p95, lat_p99: p.p99, lat_max: p.max, lat_n: p.n, fee_tkas: Number(eng.feeBurn) / 1e8, errs: eng.errs }); }, 10000);
await Promise.all(Array.from({ length: CONC }, () => lane()));
saveChains(TAG, LIVE); clearInterval(rep); log({ ev: "done", ...S }); process.exit(0);
