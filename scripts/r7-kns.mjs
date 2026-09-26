// round6 KNS bulk create v2 (user 12:27 spec). TN10 only. NEVER prints keys.
// - names: fully random [a-z0-9]; length uniform 1..8, 10% chance 15. Taken -> new random name of the same length
//   (after a length is exhausted, e.g. all 36 one-char names taken, redraw length). counts taken / invalid / retries separately.
// - owner: random address from a pool of freshly generated throwaway TN10 keys (/home/box/secure/r6-kns-owners.json, 0600).
//   The owner key is the key inside the P2SH inscription script AND the only signer of the reveal, so the reveal's
//   sender is the owner (payer = worker only funds the commit). Reveal change -> faucet.
// - name availability: batched POST /domains/check (up to 50 names per call), global throttle + backoff on CF 1015.
// - fee: 2x live normal estimate (/tmp/r6-feerate, from r6-feerate.py). KNS price: 1-2 chars 4200, 3: 2100, 4: 525, 5+: 35 TKAS.
// - funding from faucet UTXOs slice txid[8:16]%4!=0 (ttt %8==0, vprog %8==4), consolidated in <=60-input txs to the worker.
import crypto from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { kaspa, connect, NET, deskKey, addrOf } from "./lib.mjs";
const DIR = "/workspace/tn10-break-test-2026-09-25"; const TAG = process.argv[2] || "B"; const LOG = `${DIR}/logs/round7/kns-${TAG}.jsonl`;
const API = "https://api.knsdomains.org/tn10/api/v1";
const FEE = process.env.KNS_FEE_ADDR; // KNS treasury address (public; left out of this copy)
const CONC = Number(process.env.KNS_CONC || 12); const MAXN = Number(process.env.KNS_MAX || 1e12);
const FKEY = deskKey(0); const FADDR = addrOf(FKEY); const FSPK = kaspa.payToAddressScript(FADDR);
const GROK_BUILD = process.env.NO_SPEND_ADDR; // an address we must never spend from or pay (left out of this copy)
if (FADDR === GROK_BUILD) throw new Error("refusing: faucet key resolves to Grok Build wallet");
const RESF = "/tmp/r5-reserved-utxos.json";
const log = (o) => appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), ...o }) + "\n");
const feerate = () => { try { const v = BigInt(readFileSync("/tmp/r6-feerate", "utf8").trim()); if (v >= 200n) return v; } catch {} return 2000n; };
const halted = () => existsSync("/tmp/r5-games.HALT") || existsSync("/tmp/tps-storm.HALT") || existsSync("/tmp/r7.HALT");
const paused = () => existsSync("/tmp/r6-kns.PAUSE") || existsSync("/tmp/r7-kns.PAUSE");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rpc = await connect("n0");

// ---- owner pool (throwaway keys, owner-only file) ----
const OWNF = "/home/box/secure/r6-kns-owners.json";
let OWN = existsSync(OWNF) ? JSON.parse(readFileSync(OWNF, "utf8")) : [];
if (OWN.length < 2000) { while (OWN.length < 2000) OWN.push(crypto.randomBytes(32).toString("hex")); writeFileSync(OWNF, JSON.stringify(OWN), { mode: 0o600 }); chmodSync(OWNF, 0o600); }
const OWNERS = OWN.map((h) => { const k = new kaspa.PrivateKey(h); return { key: k, addr: addrOf(k) }; }); OWN = null;
writeFileSync(`${DIR}/logs/round7/kns-owner-addresses.txt`, OWNERS.map((o) => o.addr).join("\n") + "\n"); // public addresses only

// ---- names ----
const CH = "abcdefghijklmnopqrstuvwxyz0123456789";
const price = (n) => (n <= 2 ? 4200 : n === 3 ? 2100 : n === 4 ? 525 : 35);
const drawLen = () => (Math.random() < 0.1 ? 15 : 1 + Math.floor(Math.random() * 8));
const rname = (n) => Array.from({ length: n }, () => CH[crypto.randomInt(36)]).join("");
const S = { attempts: 0, created: 0, taken: 0, invalid: 0, retries: 0, len_exhausted: 0, check_calls: 0, check_fail: 0, rate_limited: 0,
  commit_fail: 0, reveal_fail: 0, fund_fail: 0, unaffordable: 0, owner_ok: 0, owner_bad: 0, owner_unk: 0, by_len_created: {}, by_len_drawn: {}, tkas_kns: 0, lat: [] };
const seen = new Set(); const avail = {}; const exhausted = new Set(); const dry = {};
let lastCall = 0; let backoffUntil = 0; let chain = Promise.resolve();
async function apiCheck(names, addr) { // serialized, throttled
  const run = async () => {
    for (let a = 0; a < 6; a++) {
      const now = Date.now(); const wait = Math.max(backoffUntil, lastCall + 1500) - now; if (wait > 0) await sleep(wait);
      lastCall = Date.now(); S.check_calls++;
      try {
        const r = await fetch(`${API}/domains/check`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ domainNames: names.map((n) => n + ".kas"), address: addr }), signal: AbortSignal.timeout(15000) });
        const txt = await r.text();
        if (txt.includes("1015") || r.status === 429) { S.rate_limited++; backoffUntil = Date.now() + 60000; log({ ev: "rate_limited" }); continue; }
        const j = JSON.parse(txt); const ds = j?.data?.domains; if (!Array.isArray(ds)) { S.check_fail++; await sleep(3000); continue; }
        return ds;
      } catch { S.check_fail++; await sleep(3000 * (a + 1)); }
    }
    return null;
  };
  const p = chain.then(run, run); chain = p.catch(() => {}); return p;
}
async function nextName(owner, maxPrice = Infinity, first = true) {
  for (let guard = 0; guard < 50; guard++) {
    let n = drawLen(); let spin = 0; while ((exhausted.has(n) || price(n) > maxPrice) && spin++ < 1000) n = drawLen(); if (spin >= 1000) return null;
    if (first) { S.by_len_drawn[n] = (S.by_len_drawn[n] || 0) + 1; first = false; }
    for (let tries = 0; tries < 6; tries++) {
      if (avail[n]?.length) return { label: avail[n].pop(), n };
      const space = 36 ** n; const cand = new Set(); let spins = 0;
      while (cand.size < 50 && spins++ < 5000) { const s = rname(n); if (!seen.has(s)) cand.add(s); }
      if (!cand.size) { exhausted.add(n); S.len_exhausted++; log({ ev: "len_exhausted", n }); break; }
      const names = [...cand]; names.forEach((s) => seen.add(s));
      const ds = await apiCheck(names, owner.addr); if (!ds) break;
      let got = 0;
      for (const d of ds) { const lab = String(d.domain || d.domainName || d.name || "").replace(/\.kas$/, "");
        if (d.available === true && d.isReservedDomain !== true && /^[a-z0-9]+$/.test(lab)) { (avail[n] ||= []).push(lab); got++; }
        else if (d.available === false && d.isReservedDomain !== true) S.taken++; else S.invalid++; }
      if (!got) { S.retries++; dry[n] = (dry[n] || 0) + 1; if (dry[n] >= 3 && space <= 36 ** 2) { exhausted.add(n); S.len_exhausted++; log({ ev: "len_exhausted", n, space }); break; } }
      else S.retries += tries;
    }
  }
  return null;
}

// ---- funding ----
const USEDF = "/workspace/tmp/r6-kns-used.txt";
const USED = new Set(existsSync(USEDF) ? readFileSync(USEDF, "utf8").split("\n").filter(Boolean) : []);
const opk = (o) => o.transactionId + ":" + o.index;
function takeFaucet(minSompi, maxIn = 60) {
  let raw = []; try { raw = JSON.parse(readFileSync(RESF, "utf8")); } catch { return null; }
  const h = (u) => parseInt(u.outpoint.transactionId.slice(8, 16), 16) % 4;
  // runners' slice (h%4==0): leave the smallest UTXOs worth 2,000 TKAS as the runners' refund reserve, KNS may take the surplus
  const run = raw.filter((u) => h(u) === 0).sort((a, b) => Number(BigInt(a.utxoEntry.amount) - BigInt(b.utxoEntry.amount)));
  let res = 0n; const surplus = []; for (const u of run) { if (res < 200000000000n) res += BigInt(u.utxoEntry.amount); else surplus.push(u); }
  const cands = raw.filter((u) => h(u) === 1 || h(u) === 3) /* r7: h%4==2 reserved for covenant prototypes */.concat(surplus).filter((u) => !USED.has(opk(u.outpoint))).sort((a, b) => Number(BigInt(b.utxoEntry.amount) - BigInt(a.utxoEntry.amount)));
  const out = []; let sum = 0n;
  for (const u of cands) { out.push(u); sum += BigInt(u.utxoEntry.amount); if (sum >= minSompi || out.length >= maxIn) break; }
  if (!out.length) return null;
  for (const u of out) { USED.add(opk(u.outpoint)); appendFileSync(USEDF, opk(u.outpoint) + "\n"); }
  return out;
}
async function topUp(w, needSompi) { // add faucet funds as new worker UTXOs until balance >= need (each tx <=60 inputs)
  let bal = w.utxos.reduce((a, u) => a + u.amount, 0n);
  for (let round = 0; bal < needSompi && round < 12; round++) {
    const seeds = takeFaucet(needSompi - bal + 1000000000n); if (!seeds) return false;
    const ins = seeds.map((u) => ({ address: FADDR, outpoint: u.outpoint, utxoEntry: { amount: BigInt(u.utxoEntry.amount), scriptPublicKey: FSPK, blockDaaScore: BigInt(u.utxoEntry.blockDaaScore), isCoinbase: u.utxoEntry.isCoinbase } }));
    const total = ins.reduce((a, x) => a + x.utxoEntry.amount, 0n);
    let tx = kaspa.createTransaction(ins, [{ address: w.addr, amount: total - 1n }], 0n, null, 1); kaspa.signTransaction(tx, [FKEY], false);
    const amt = total - BigInt(kaspa.calculateTransactionMass(NET, tx)) * feerate() - 10000n;
    if (amt <= 0n) return false;
    tx = kaspa.createTransaction(ins, [{ address: w.addr, amount: amt }], 0n, null, 1); kaspa.signTransaction(tx, [FKEY], false);
    try { await rpc.submitTransaction({ transaction: tx, allowOrphan: false }); } catch (e) { S.fund_fail++; log({ ev: "fund_fail", e: String(e.message || e).slice(0, 120) }); return false; }
    w.utxos.push({ outpoint: { transactionId: tx.id, index: 0 }, amount: amt }); bal += amt;
  }
  return bal >= needSompi;
}
const WKF = "/home/box/secure/r6-kns-workers.txt"; // worker keys (owner-only) so leftover change is recoverable after a restart
const newWorker = () => { const hex = crypto.randomBytes(32).toString("hex"); appendFileSync(WKF, hex + "\n", { mode: 0o600 }); chmodSync(WKF, 0o600); const key = new kaspa.PrivateKey(hex); const addr = addrOf(key); return { key, addr, spk: kaspa.payToAddressScript(addr), utxos: [] }; };

// ---- create ----
const created = [];
async function createOne(w) {
  const owner = OWNERS[crypto.randomInt(OWNERS.length)];
  // intended length is drawn from the spec distribution; if the faucet cannot fund it (income-limited), redraw among the
  // lengths the worker's current balance can afford (counted as 'unaffordable') instead of hoarding partial top-ups.
  const MAXP = Number(process.env.KNS_MAXPRICE || 525); let nm = await nextName(owner, MAXP); if (!nm) return w; let { label, n } = nm; // r7: budget cap (3-char 2100 / 1-2-char 4200 TKAS skipped by default)
  const fr = feerate(); const revealFeeGuess = 5000n * fr; const overhead = revealFeeGuess + 20000000n + 10000n * fr + 100000000n;
  const need = (k) => BigInt(kaspa.kaspaToSompi(String(price(k)))) + overhead;
  if (!(await topUp(w, need(n)))) {
    S.unaffordable++; (avail[n] ||= []).push(label);
    const bal = w.utxos.reduce((a, u) => a + u.amount, 0n); const maxP = Number((bal - overhead) / 100000000n);
    if (maxP < 35) { await sleep(5000); return w; }
    nm = await nextName(owner, maxP, false); if (!nm) { await sleep(5000); return w; } ({ label, n } = nm);
  }
  const kfee = BigInt(kaspa.kaspaToSompi(String(price(n))));
  const lock = kfee + revealFeeGuess + 20000000n; // KNS price + reveal miner fee + 0.2 TKAS margin (back to faucet)
  S.attempts++; const payload = JSON.stringify({ op: "create", p: "domain", v: label });
  const script = new kaspa.ScriptBuilder().addData(owner.key.toKeypair().xOnlyPublicKey).addOp(kaspa.Opcodes.OpCheckSig).addOp(kaspa.Opcodes.OpFalse).addOp(kaspa.Opcodes.OpIf).addData(Buffer.from("kns")).addI64(0n).addData(Buffer.from(payload)).addOp(kaspa.Opcodes.OpEndIf);
  const p2shSpk = script.createPayToScriptHashScript(); const p2shAddr = kaspa.addressFromScriptPublicKey(p2shSpk, NET).toString();
  const ins = w.utxos.map((u) => ({ address: w.addr, outpoint: u.outpoint, utxoEntry: { amount: u.amount, scriptPublicKey: w.spk, blockDaaScore: 0n, isCoinbase: false } }));
  const total = w.utxos.reduce((a, u) => a + u.amount, 0n);
  const mk = (ch) => { const t = kaspa.createTransaction(ins, [{ address: p2shAddr, amount: lock }, { address: w.addr, amount: ch }], 0n, null, 1); kaspa.signTransaction(t, [w.key], false); return t; };
  let commit = mk(total - lock - 5000n * fr); const change = total - lock - BigInt(kaspa.calculateTransactionMass(NET, commit)) * fr; commit = mk(change);
  const t0 = Date.now();
  try { await rpc.submitTransaction({ transaction: commit, allowOrphan: false }); }
  catch (e) { S.commit_fail++; log({ ev: "commit_fail", label, e: String(e.message || e).slice(0, 300) }); (avail[n] ||= []).push(label);
    // r7 FIX: round-6 logic abandoned the worker here (return null) -> its whole top-up stayed in a now-idle key and the next worker
    // topped up again (74k TKAS parked in 50 idle workers in 5 min, recovered by r7-sweep-kns.mjs). Now: keep the worker, re-read its
    // live UTXO set from the public API after a pause, and retry.
    await sleep(8000);
    try { const us = await (await fetch("https://api-tn10.kaspa.org/addresses/utxos", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ addresses: [w.addr] }), signal: AbortSignal.timeout(30000) })).json();
      w.utxos = us.filter((u) => u.address === w.addr).slice(0, 80).map((u) => ({ outpoint: { transactionId: u.outpoint.transactionId, index: u.outpoint.index }, amount: BigInt(u.utxoEntry.amount) })); S.worker_refresh = (S.worker_refresh || 0) + 1; }
    catch { S.worker_refresh_fail = (S.worker_refresh_fail || 0) + 1; }
    return w; }
  w.utxos = [{ outpoint: { transactionId: commit.id, index: 1 }, amount: change }];
  // reveal: ONLY the P2SH input (signed by the owner key) -> [KNS fee sink, remainder -> faucet]
  const pin = { address: p2shAddr, outpoint: { transactionId: commit.id, index: 0 }, utxoEntry: { amount: lock, scriptPublicKey: p2shSpk, blockDaaScore: 0n, isCoinbase: false } };
  const mkR = (back) => kaspa.createTransaction([pin], [{ address: FEE, amount: kfee }, { address: FADDR, amount: back }], 0n, null, 1);
  const fill = (t) => { t.inputs[0].signatureScript = script.encodePayToScriptHashSignatureScript(kaspa.createInputSignature(t, 0, owner.key)); return t; };
  let reveal = fill(mkR(lock - kfee - revealFeeGuess)); const rfee = BigInt(kaspa.calculateTransactionMass(NET, reveal)) * fr; reveal = fill(mkR(lock - kfee - rfee));
  let rid = null;
  for (let a = 0; a < 4 && !rid; a++) { try { rid = await rpc.submitTransaction({ transaction: reveal, allowOrphan: a > 0 }); } catch (e) { if (a === 3) { S.reveal_fail++; log({ ev: "reveal_fail", label, n, e: String(e.message || e).slice(0, 160) }); } else await sleep(500); } }
  if (!rid) return w;
  S.created++; S.by_len_created[n] = (S.by_len_created[n] || 0) + 1; S.tkas_kns += price(n); S.lat.push(Date.now() - t0);
  const rec = { ev: "created", label, n, owner: owner.addr, commit: commit.id, reveal: reveal.id, price: price(n), feerate: Number(fr) };
  log(rec); created.push({ label, owner: owner.addr, t: Date.now() });
  return w;
}
const WB = new Map();
// adopt previously persisted workers that still hold coins (live POST /addresses/utxos on the public TN10 API)
const ADOPT = [];
try {
  const hexes = existsSync(WKF) ? [...new Set(readFileSync(WKF, "utf8").split("\n").filter(Boolean))] : [];
  const ws = hexes.map((h) => { const key = new kaspa.PrivateKey(h); const addr = addrOf(key); return { key, addr, spk: kaspa.payToAddressScript(addr), utxos: [] }; });
  const by = new Map(ws.map((w) => [w.addr, w]));
  for (let i = 0; i < ws.length; i += 50) {
    const r = await fetch("https://api-tn10.kaspa.org/addresses/utxos", { method: "POST", headers: { "content-type": "application/json", "User-Agent": "grok-r6-kns" }, body: JSON.stringify({ addresses: ws.slice(i, i + 50).map((w) => w.addr) }), signal: AbortSignal.timeout(60000) });
    for (const u of await r.json()) { const w = by.get(u.address); if (w) w.utxos.push({ outpoint: { transactionId: u.outpoint.transactionId, index: u.outpoint.index }, amount: BigInt(u.utxoEntry.amount) }); }
  }
  for (const w of ws) if (w.utxos.length) { w.utxos = w.utxos.slice(0, 80); ADOPT.push(w); }
  log({ ev: "adopt", persisted: ws.length, with_coins: ADOPT.length, tkas: Math.round(Number(ADOPT.reduce((a, w) => a + w.utxos.reduce((b, u) => b + u.amount, 0n), 0n)) / 1e8) });
} catch (e) { log({ ev: "adopt_fail", e: String(e.message || e).slice(0, 120) }); }
async function worker(i) {
  let w = null;
  while (!halted() && S.created < MAXN) {
    if (paused()) { await sleep(5000); continue; }
    if (!w) w = ADOPT.pop() || newWorker();
    w = await createOne(w); WB.set(i, w ? w.utxos.reduce((a, u) => a + u.amount, 0n) : 0n);
  }
}
// ownership sampler: one created name older than 3 min every 45 s
setInterval(async () => {
  const c = created.filter((x) => Date.now() - x.t > 180000); if (!c.length || Date.now() < backoffUntil) return;
  const x = c.splice(crypto.randomInt(c.length), 1)[0]; created.splice(created.indexOf(x), 1);
  try { const r = await fetch(`${API}/${encodeURIComponent(x.label + ".kas")}/owner`, { signal: AbortSignal.timeout(15000) }); const txt = await r.text();
    if (txt.includes(x.owner)) S.owner_ok++; else if (r.status === 200) { S.owner_bad++; log({ ev: "owner_mismatch", label: x.label, want: x.owner, got: txt.slice(0, 200) }); } else S.owner_unk++;
  } catch { S.owner_unk++; }
}, 45000);
log({ ev: "start", tag: TAG, conc: CONC, owners: OWNERS.length });
const rep = setInterval(() => { const l = [...S.lat].sort((a, b) => a - b); const p = (q) => (l.length ? l[Math.min(l.length - 1, Math.floor(l.length * q))] : null);
  const wb = Number([...WB.values()].reduce((a, b) => a + b, 0n)) / 1e8; writeFileSync("/tmp/r7-kns-balance", String(Math.round(wb)));
  log({ ev: "rep", worker_bal_tkas: Math.round(wb), ...S, lat: undefined, lat_p50: p(0.5), lat_p95: p(0.95), lat_n: l.length, feerate_now: Number(feerate()), exhausted: [...exhausted] }); S.lat = []; }, 15000);
await Promise.all(Array.from({ length: CONC }, (_, i) => worker(i)));
clearInterval(rep); log({ ev: "done", ...S, lat: undefined }); process.exit(0);
