// round5 index-free tic-tac-toe (TN10 only). Many concurrent games. Each game is a fresh chain funded from a faucet seed
// (reserved subset 1). Each MOVE is a 1-in-1-out tx whose payload encodes the full board after the move:
//   payload = "TTT1" | gameId(4B) | seq(1B) | player(1B '0'/'1') | cell(1B '0'-'8') | board(9B, chars '-','X','O')
// The move spends the previous chain output and returns change to a fresh in-game address. Legality is enforced by
// validate() BEFORE building the tx: a move is legal iff cell in 0..8, board[cell]=='-', correct player to move, game not
// over. We periodically attempt an ILLEGAL move (occupied cell / wrong turn / out-of-range) and assert it is refused
// locally (never submitted) -> "illegal_executed" must stay 0. A game ends at win/draw; a final "over" payload is sent.
import crypto from "node:crypto";
import { appendFileSync } from "node:fs";
import { kaspa, NET, addrOf } from "./lib.mjs";
import { releaseSeeds, feerate, saveChains, loadChains, setKeyTag, Engine, takeSeeds, fundChain, buildMove, halted, sleep, DIR } from "./r7-engine.mjs";

const TAG = process.argv[2] || "A";
const CONC = Number(process.env.TTT_CONC || 40);          // concurrent games
const ILLEGAL_EVERY = Number(process.env.TTT_ILLEGAL || 4); // try an illegal move with probability 1/ILLEGAL_EVERY before each legal move
const LOG = `${DIR}/logs/round7/ttt-${TAG}.jsonl`;
const log = (o) => appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), ...o }) + "\n");

const WINS = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
const winner = (b) => { for (const [a,c,d] of WINS) if (b[a] !== "-" && b[a] === b[c] && b[c] === b[d]) return b[a]; return null; };
const full = (b) => b.every((x) => x !== "-");
// legality check (pure). player: 0->X,1->O. Returns null if legal, else a reason string.
function illegalReason(board, player, cell) {
  if (!Number.isInteger(cell) || cell < 0 || cell > 8) return "cell-range";
  if (winner(board) || full(board)) return "game-over";
  const marks = board.filter((x) => x !== "-").length;
  const expected = marks % 2;               // X on even count, O on odd
  if (player !== expected) return "wrong-turn";
  if (board[cell] !== "-") return "cell-occupied";
  return null;
}
const hex = (s) => Buffer.from(s, "utf8").toString("hex");
const u32 = (n) => Buffer.from(Uint32Array.of(n).buffer).toString("hex");
const payload = (gid, seq, player, cell, board) => hex("TTT1") + u32(gid) + hex(String(seq % 10)) + hex(String(player)) + hex(cell < 0 ? "x" : String(cell)) + hex(board.join(""));

// pick a legal move (prefer win, then block, else random) to keep games realistic and finite
function chooseMove(board, player) {
  const me = player === 0 ? "X" : "O", opp = player === 0 ? "O" : "X";
  const empties = [...board.keys()].filter((i) => board[i] === "-");
  for (const c of empties) { const t = [...board]; t[c] = me; if (winner(t) === me) return c; }
  for (const c of empties) { const t = [...board]; t[c] = opp; if (winner(t) === opp) return c; }
  return empties[(Math.random() * empties.length) | 0];
}

let stats = { games_started: 0, games_finished: 0, wins: 0, draws: 0, moves: 0, illegal_attempts: 0, illegal_refused: 0, illegal_executed: 0, fund_fail: 0, game_fail: 0 };
let gidCounter = (crypto.randomBytes(2).readUInt16BE(0)) << 8;

async function playGame(eng, start, onMove) {  // start = chain output we own; returns the chain end (or null if the chain broke)
  const gid = gidCounter++ & 0xffffffff;
  stats.games_started++;
  let cur = start; let board = Array(9).fill("-"); let seq = 1; let movesThis = 0;
  while (!halted()) {
    const player = board.filter((x) => x !== "-").length % 2;
    // periodic illegal attempt: must be refused locally, never submitted
    if (movesThis > 0 && Math.random() < 1 / ILLEGAL_EVERY) {
      stats.illegal_attempts++;
      const kind = (Math.random() * 3) | 0;
      let badCell;
      if (kind === 0) { const occ = [...board.keys()].filter((i) => board[i] !== "-"); badCell = occ.length ? occ[0] : 0; }
      else if (kind === 1) badCell = 99;               // out of range
      else badCell = [...board.keys()].find((i) => board[i] === "-") ?? 0; // valid cell but WRONG player
      const asPlayer = kind === 2 ? (player ^ 1) : player;
      const reason = illegalReason(board, asPlayer, kind === 1 ? badCell : badCell);
      if (reason) stats.illegal_refused++; else { stats.illegal_executed++; log({ ev: "ILLEGAL_EXECUTED", gid, kind, badCell, board: board.join("") }); }
      // do NOT build/submit the illegal move.
    }
    const cell = chooseMove(board, player);
    if (illegalReason(board, player, cell)) { stats.game_fail++; break; } // should never happen
    board[cell] = player === 0 ? "X" : "O";
    const fresh = cur.key; const toAddr = cur.address; // r7: chain keeps its derived key (recoverable)
    const mv = buildMove({ ...cur }, cur.key, toAddr, payload(gid, seq, player, cell, board));
    if (!mv) { stats.chain_low = (stats.chain_low || 0) + 1; return null; }
    if (!(await eng.submit(mv))) { stats.game_fail++; return null; }
    stats.moves++; movesThis++; seq++; cur = { ...mv.out, key: fresh }; onMove(cur);
    const w = winner(board);
    if (w || full(board)) { stats.games_finished++; if (w) stats.wins++; else stats.draws++;
      // final marker move (optional, keeps chain closed); ignore failure
      break; }
    if (movesThis > 12) { stats.game_fail++; break; }
  }
  return cur;
}

setKeyTag("ttt-" + TAG); const eng = new Engine(`ttt-${TAG}`); await eng.connect(); eng.startGuards(process.env.RATEFILE || "/tmp/r5-ttt.rate");
log({ ev: "start", tag: TAG, conc: CONC, feerate: process.env.FEERATE });
const GAME_TKAS = BigInt(Math.round(Number(process.env.TTT_FUND_TKAS || 4) * 1e8));
const LIVE = new Map(); let laneN = 0; const RESUME = loadChains(TAG); log({ ev: "resume", chains: RESUME.length });
setInterval(() => { try { saveChains(TAG, LIVE); } catch (e) { log({ ev: "save-err", e: String(e).slice(0, 120) }); } }, 5000);
async function lane() {
  const id = laneN++; let cur = RESUME.pop() || null;
  while (!halted()) {
    if (!cur) { const seeds = takeSeeds(1, GAME_TKAS);
      if (!seeds) { stats.no_seed = (stats.no_seed || 0) + 1; await sleep(3000); continue; }
      const f = fundChain(seeds, payload(0, 0, 0, -1, Array(9).fill("-")));
      if (!f || !(await eng.submit(f))) { stats.fund_fail++; releaseSeeds(seeds); await sleep(1000); continue; }
      stats.chains_funded = (stats.chains_funded || 0) + 1; cur = f.out; LIVE.set(id, cur); }
    try { cur = await playGame(eng, cur, (c) => LIVE.set(id, c)); } catch (e) { cur = null; stats.game_fail++; log({ ev: "exc", e: String(e).slice(0, 200) }); }
    LIVE.set(id, cur);
  }
}
const rep = setInterval(() => {
  const p = eng.pstats();
  log({ ev: "rep", ...stats, feerate: Number(feerate()), rate: eng.rate, paused: eng.paused, mp: eng.mp, retries: eng.retries || 0, resume_stale: eng.resume_stale || 0, submitted: eng.submitted, accepted: eng.accepted, rejected: eng.rejected,
    lat_p50: p.p50, lat_p95: p.p95, lat_p99: p.p99, lat_max: p.max, lat_n: p.n, fee_tkas: Number(eng.feeBurn) / 1e8, errs: eng.errs });
}, 10000);
await Promise.all(Array.from({ length: CONC }, () => lane()));
saveChains(TAG, LIVE); clearInterval(rep);
log({ ev: "done", ...stats });
process.exit(0);
