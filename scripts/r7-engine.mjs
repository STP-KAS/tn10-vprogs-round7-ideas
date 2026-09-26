// round5 index-free game/vprog engine (TN10 only). No utxoindex: every chain tracks its own UTXO locally.
// Each game/program is SEEDED by a funding tx from the faucet (desk key 0) to a fresh per-chain key; we know the
// funding output (txid:index) because we built it. Every subsequent move/step is a 1-in-1-out signed tx that spends the
// PREVIOUS output of the same chain and carries the new state in the payload. We submit moves back-to-back (Kaspa allows
// chained mempool txs), so a chain does not wait for on-chain acceptance between moves; acceptance is tracked async via
// the virtual-chain-changed notification for latency stats. HIGH feerate (env FEERATE sompi/gram) so moves are not
// evicted by the 150x storm. Illegal moves are rejected by validate() BEFORE building a tx (never submitted).
import crypto from "node:crypto";
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { kaspa, connect, NET, deskKey, addrOf } from "./lib.mjs";

export const DIR = "/workspace/tn10-break-test-2026-09-25";
const HALT = ["/tmp/r5-games.HALT", "/tmp/tps-storm.HALT", "/tmp/r7.HALT"]; // r6: faucet-empty no longer halts runners (income-only mode)
export const halted = () => HALT.some((f) => existsSync(f));

// faucet (desk key 0)
const FKEY = deskKey(0); const FADDR = addrOf(FKEY); const FSPK = kaspa.payToAddressScript(FADDR);
export const faucetAddr = FADDR;

// reserved faucet UTXOs for our runners: hash%4==SUBSET (ttt=1, vprog=3). Written by r5-desk-feeder.py.
const RESF = "/tmp/r5-reserved-utxos.json";
export function loadSeeds(subset) {
  let raw = []; try { raw = JSON.parse(readFileSync(RESF, "utf8")); } catch { return []; }
  return raw.filter((u) => { const h = parseInt(u.outpoint.transactionId.slice(8, 16), 16); return subset === 1 ? h % 8 === 0 : h % 8 === 4; }) // r6 12:37: ttt h%8==0, vprog h%8==4, KNS h%4!=0 (r6-kns2.mjs, 3/4 of faucet: best TKAS-per-disk burner)
    .map((u) => ({ txid: u.outpoint.transactionId, index: u.outpoint.index, amount: BigInt(u.utxoEntry.amount), daa: BigInt(u.utxoEntry.blockDaaScore) }));
}

// sompi/gram; live-tunable via /tmp/r5-feerate (re-read every 2 s), else env FEERATE
let FR = BigInt(process.env.FEERATE || 20000);
const rdFR = () => { try { const v = BigInt(readFileSync(existsSync("/tmp/r6-feerate") ? "/tmp/r6-feerate" : "/tmp/r5-feerate", "utf8").trim()); if (v >= 200n) FR = v; } catch {} }; // r6: dynamic 2x normal estimate
rdFR(); setInterval(rdFR, 2000);
export const feerate = () => FR;
const FUND_FR_ENV = process.env.FUND_FEERATE; const fundFR = () => FUND_FR_ENV ? BigInt(FUND_FR_ENV) : FR; // r6: funding uses the same dynamic 2x-normal rule
const MINCH = BigInt(process.env.MINCH_SOMPI || 100000000); // stop a chain below 1 TKAS (storage mass grows as the balance shrinks)

function feeFor(tx) { return BigInt(kaspa.calculateTransactionMass(NET, tx)) * feerate(); }

// build & sign a 1-in-1-out tx: spend `inp` (owned by `key`), send change-minus-fee back to `toAddr`, payload=hex string.
export function buildMove(inp, key, toAddr, payloadHex) {
  const toSpk = kaspa.payToAddressScript(toAddr);
  let tx = kaspa.createTransaction([{ address: inp.address, outpoint: { transactionId: inp.txid, index: inp.index },
    utxoEntry: { amount: inp.amount, scriptPublicKey: inp.spk, blockDaaScore: inp.daa || 0n, isCoinbase: inp.isCoinbase || false } }],
    [{ address: toAddr, amount: inp.amount - 1n }], 0n, payloadHex, 1);
  kaspa.signTransaction(tx, [key], false);
  let fee = feeFor(tx), amt;
  for (let it = 0; it < 3; it++) { // iterate: fee changes the output -> KIP-9 storage mass -> fee
    amt = inp.amount - fee; if (amt < MINCH) return null;
    tx = kaspa.createTransaction([{ address: inp.address, outpoint: { transactionId: inp.txid, index: inp.index },
      utxoEntry: { amount: inp.amount, scriptPublicKey: inp.spk, blockDaaScore: inp.daa || 0n, isCoinbase: inp.isCoinbase || false } }],
      [{ address: toAddr, amount: amt }], 0n, payloadHex, 1);
    kaspa.signTransaction(tx, [key], false); const f2 = feeFor(tx); if (f2 <= fee) break; fee = f2; }
  return { tx, out: { txid: tx.id, index: 0, amount: amt, address: toAddr, spk: toSpk, key, daa: 0n }, fee, _resume: !!inp._resume };
}

// fund a fresh chain key from 1..n faucet seed UTXOs (all spent in ONE tx). Returns the funding output (known locally) or null.
const USEDF = "/workspace/tmp/r5-used-seeds.txt"; // persisted across restarts (append-only txid:index)
const USED = new Set(existsSync(USEDF) ? readFileSync(USEDF, "utf8").split("\n").filter(Boolean) : []);
export function takeSeeds(subset, want) {
  const seeds = loadSeeds(subset).filter((s) => !USED.has(s.txid + ":" + s.index)).sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0)); // biggest first
  const out = []; let sum = 0n;
  for (const s of seeds) { out.push(s); sum += s.amount; if (sum >= want || out.length >= 16) break; }
  if (sum < want / 2n) return null; // r5 10:05: accept half the target (faucet UTXOs are small, ~1-3 TKAS)
  for (const s of out) { USED.add(s.txid + ":" + s.index); appendFileSync(USEDF, s.txid + ":" + s.index + "\n"); }
  return out;
}
export function releaseSeeds(seeds) { for (const s of seeds || []) USED.delete(s.txid + ":" + s.index); } // failed funding: seeds become usable again
// r7: chain keys are DERIVED (sha256(seed | tag | i)) and the counter is persisted (fsync'd) BEFORE the key is funded,
// so a crash can never strand a funded chain in an unknown key (round-6 lessons: ~26k KNS top-ups + ttt/vprog tag-E file collision).
import { openSync, writeSync, fsyncSync, closeSync } from "node:fs";
const SEEDF = "/home/box/secure/r7-chain-seed.hex";
if (!existsSync(SEEDF)) { writeFileSync(SEEDF, crypto.randomBytes(32).toString("hex"), { mode: 0o600 }); }
const SEED = readFileSync(SEEDF, "utf8").trim();
export function deriveKey(tag, i) { return new kaspa.PrivateKey(crypto.createHash("sha256").update(SEED + "|" + tag + "|" + i).digest("hex")); }
let KTAG = null, KCTR = 0;
export function setKeyTag(tag) { KTAG = tag; const f = `/home/box/secure/r7-keyctr-${tag}.txt`; KCTR = existsSync(f) ? Number(readFileSync(f, "utf8").trim()) : 0; }
function nextChainKey() {
  if (!KTAG) throw new Error("setKeyTag first");
  const i = KCTR++; const f = `/home/box/secure/r7-keyctr-${KTAG}.txt`;
  const fd = openSync(f + ".tmp", "w", 0o600); writeSync(fd, String(KCTR)); fsyncSync(fd); closeSync(fd); renameSync(f + ".tmp", f);
  return deriveKey(KTAG, i);
}
export function fundChain(seeds, payloadHex) {
  if (!Array.isArray(seeds)) seeds = [seeds];
  const key = nextChainKey();
  const addr = addrOf(key); const spk = kaspa.payToAddressScript(addr);
  const ins = seeds.map((seed) => ({ address: FADDR, outpoint: { transactionId: seed.txid, index: seed.index },
    utxoEntry: { amount: seed.amount, scriptPublicKey: FSPK, blockDaaScore: seed.daa, isCoinbase: true } }));
  const total = seeds.reduce((a, s) => a + s.amount, 0n);
  let tx = kaspa.createTransaction(ins, [{ address: addr, amount: total - 1n }], 0n, payloadHex, 1);
  kaspa.signTransaction(tx, [FKEY], false);
  const fee = BigInt(kaspa.calculateTransactionMass(NET, tx)) * fundFR(); const amt = total - fee;
  if (amt < MINCH) return null;
  tx = kaspa.createTransaction(ins, [{ address: addr, amount: amt }], 0n, payloadHex, 1);
  kaspa.signTransaction(tx, [FKEY], false);
  return { tx, key, out: { txid: tx.id, index: 0, amount: amt, address: addr, spk, key, daa: 0n }, fee };
}

// acceptance tracker via virtual-chain-changed (submit time -> accept time)
export class Engine {
  constructor(tag) { this.tag = tag; this.rpc = null; this.pending = new Map(); this.lat = []; this.accepted = 0; this.submitted = 0; this.rejected = 0; this.errs = {}; this.feeBurn = 0n; }
  async connect() {
    this.rpc = await connect("n0");
    this.rpc.addEventListener("virtual-chain-changed", (e) => {
      const now = Date.now();
      for (const a of e.data.acceptedTransactionIds || []) for (const id of a.acceptedTransactionIds || []) {
        const t0 = this.pending.get(id); if (t0 !== undefined) { this.lat.push(now - t0); this.accepted++; this.pending.delete(id); }
      }
    });
    await this.rpc.subscribeVirtualChainChanged(true);
  }
  // live rate cap (moves/s, file RATEFILE re-read every 2 s) + own mempool guard (pause when n0 mempool > MP_PAUSE, resume < MP_RESUME)
  startGuards(rateFile) {
    this.rate = 50; this.tokens = 0; this.last = Date.now(); this.mp = 0; this.paused = false;
    const MPP = Number(process.env.MP_PAUSE || 75000), MPR = Number(process.env.MP_RESUME || 55000);
    const rr = () => { try { const v = Number(readFileSync(rateFile, "utf8").trim()); if (Number.isFinite(v)) this.rate = v; } catch {} };
    rr(); setInterval(rr, 2000);
    setInterval(async () => { try { this.mp = Number((await this.rpc.getInfo()).mempoolSize);
      if (!this.paused && this.mp > MPP) this.paused = true; else if (this.paused && this.mp < MPR) this.paused = false; } catch {} }, 2000);
  }
  async token() {
    for (;;) { if (halted()) return false; const now = Date.now();
      if (!this.paused) { this.tokens = Math.min(Math.max(this.rate, 1), this.tokens + (now - this.last) * this.rate / 1000); }
      this.last = now; if (!this.paused && this.tokens >= 1) { this.tokens -= 1; return true; } await sleep(this.paused ? 500 : 20); }
  }
  async submit(built) {
    if (this.rate !== undefined && !(await this.token())) return false;
    try {
      const t0 = Date.now(); await this.rpc.submitTransaction({ transaction: built.tx, allowOrphan: false });
      this.submitted++; this.feeBurn += built.fee; this.pending.set(built.tx.id, t0); return true;
    } catch (e) { const raw = String(e.message || e);
      // r6: orphan = parent not yet visible (restart race / funding tx still propagating) -> retry up to 3x after 400 ms
      if (/orphan/.test(raw) && (built._tries || 0) < 3) { built._tries = (built._tries || 0) + 1; this.retries = (this.retries || 0) + 1; await sleep(400); return this.submit(built); }
      const m = raw.replace(/[0-9a-f]{64}/g, "<h>").replace(/\d{4,}/g, "<n>").slice(0, 100);
      if (built._resume && /already spent|orphan/.test(raw)) { this.resume_stale = (this.resume_stale || 0) + 1; return false; } // stale persisted chain end: not a runtime failure
      this.errs[m] = (this.errs[m] || 0) + 1; this.rejected++; return false; }
  }
  pstats() { const l = [...this.lat].sort((a, b) => a - b); const p = (q) => l.length ? l[Math.min(l.length - 1, Math.floor(l.length * q))] : null;
    return { n: l.length, p50: p(0.5), p95: p(0.95), p99: p(0.99), max: l.length ? l[l.length - 1] : null }; }
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// r5 09:55: persist live chain ends (private key hex + outpoint) so a stop/restart does not strand chain balances.
// File is mode 600 under /home/box/secure (never printed/committed). On start, runners resume these chains first.
import { chmodSync, renameSync } from "node:fs";
export const chainFile = (tag) => `/home/box/secure/r7-chains-${tag}.json`;
export function saveChains(tag, live) {
  const arr = []; for (const c of live.values()) if (c) arr.push({ k: c.key.toString(), txid: c.txid, index: c.index, amount: String(c.amount), address: c.address });
  const f = chainFile(tag); writeFileSync(f + ".tmp", JSON.stringify(arr), { mode: 0o600 }); chmodSync(f + ".tmp", 0o600); renameSync(f + ".tmp", f);
}
export function loadChains(tag) {
  try { return JSON.parse(readFileSync(chainFile(tag), "utf8")).map((c) => { const key = new kaspa.PrivateKey(c.k);
    return { txid: c.txid, index: c.index, amount: BigInt(c.amount), address: c.address, spk: kaspa.payToAddressScript(c.address), key, daa: 0n, _resume: true }; }); } catch { return []; }
}
