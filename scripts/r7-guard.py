#!/usr/bin/env python3
"""round7 guard (TN10). Every 15 s. Pauses by writing rate files / pause files; never kills miners or n0 except the 18:45 pruning rule.
 DISK   free < 11.0 G -> pause ttt/vprog/cov (resume > 11.5 G). free < 10.0 G -> pause KNS too (resume > 10.5). free < 8.5 G -> HALT all senders (/tmp/r7.HALT).
 MEMPOOL > 90k -> pause all senders (resume < 60k). (runners also self-pause at MP_PAUSE.)
 RAM    MemAvailable < 1.0 G -> pause all (resume > 1.5 G).
 FUNDS  mature faucet (feeder faucet.jsonl) < 1500 TKAS for 10 min -> pause all senders (income-only rebuild); resume > 5000.
 PRUNE  18:30 pause all senders + clean caches. 18:45: free < 20 G -> SIGINT n0 (exact pid) and LEAVE IT STOPPED (restart needs a user
        decision: fresh resync vs. accept pruning transient; 07:03 transient was ~+14 G). free >= 20 G -> keep n0, resume after pruning settles.
Rates restored from /tmp/r7-rates.json (the intended rates) when no pause reason remains."""
import json, time, os, shutil, subprocess, asyncio, re, signal, datetime as dt
import websockets
D = "/workspace/tn10-break-test-2026-09-25"; LOG = f"{D}/logs/round7/guard.jsonl"; RAMP = f"{D}/logs/storm/ramp.log"
NLOG = "/tmp/kaspa-logs-tn10-n0/stdout.log"
GAME_RATES = ["/tmp/r7-ttt.rate", "/tmp/r7-vprog.rate", "/tmp/r7-cov.rate"]
def now(): return dt.datetime.now()
def at(h, m): return now().replace(hour=h, minute=m, second=0, microsecond=0)
def ramp(s): open(RAMP, "a").write(f"{time.strftime('%Y-%m-%dT%H:%M:%S%z')} R7-GUARD {s}\n")
def log(o): open(LOG, "a").write(json.dumps({"t": time.strftime("%Y-%m-%dT%H:%M:%S%z"), **o}) + "\n")
def wr(f, v): open(f + ".tmp", "w").write(str(v)); os.replace(f + ".tmp", f)
def intended():
    try: return json.load(open("/tmp/r7-rates.json"))
    except Exception: return {}
async def _mp():
    async with websockets.connect("ws://127.0.0.1:18210", open_timeout=5, max_size=2**22) as ws:
        await ws.send(json.dumps({"id": 1, "method": "getInfo", "params": {}}))
        while True:
            r = json.loads(await asyncio.wait_for(ws.recv(), 8))
            if r.get("id") == 1: return int(r["params"]["mempoolSize"])
def mempool():
    try: return asyncio.run(_mp())
    except Exception: return None
def memavail():
    for l in open("/proc/meminfo"):
        if l.startswith("MemAvailable"): return int(l.split()[1]) / 2**20
def faucet():
    try:
        with open(f"{D}/logs/round5/faucet.jsonl", "rb") as f:
            f.seek(max(0, os.path.getsize(f.name) - 4000)); ls = f.read().decode(errors="ignore").strip().split("\n")[1:]
        j = [json.loads(x) for x in ls if '"mature_tkas"' in x][-1]
        if time.time() - dt.datetime.strptime(j["t"], "%Y-%m-%dT%H:%M:%S%z").timestamp() > 600: return None
        return float(j["mature_tkas"])
    except Exception: return None
def n0_pid():
    for p in os.listdir("/proc"):
        if not p.isdigit(): continue
        try: c = open(f"/proc/{p}/cmdline", "rb").read().split(b"\0")
        except Exception: continue
        if c and c[0].endswith(b"/kaspad") and b"--appdir=/tmp/kaspa-data-tn10-n0" in c: return int(p)
    return None
game_reasons, kns_reasons = set(), set()
def apply():
    want = intended()
    for f in GAME_RATES:
        wr(f, 0 if game_reasons else want.get(os.path.basename(f), 0))
    # r7 fix 16:01: a manual KNS pause lives in /tmp/r7-kns.MANUAL and is respected (the guard used to delete manual pauses every 60 s)
    kr = set(kns_reasons) | ({"manual"} if os.path.exists("/tmp/r7-kns.MANUAL") else set())
    if kr: open("/tmp/r7-kns.PAUSE", "w").write(",".join(sorted(kr)))
    else:
        try: os.remove("/tmp/r7-kns.PAUSE")
        except FileNotFoundError: pass
def setr(reason, on, kns=True):
    changed = False
    for s, use in ((game_reasons, True), (kns_reasons, kns)):
        if not use: continue
        if on and reason not in s: s.add(reason); changed = True
        if not on and reason in s: s.discard(reason); changed = True
    if changed: ramp(f"{'PAUSE' if on else 'clear'} {reason}; games paused by {sorted(game_reasons)}, KNS paused by {sorted(kns_reasons)}")
    return changed
prune = "none"; low_since = None; last_apply = 0
ramp(f"started pid {os.getpid()} (disk games<11.0 KNS<10.0 HALT<8.5 G, mp 90k, RAM 1 G, faucet<1.5k/10min, pruning 18:30/18:45)")
while True:
    t = now(); free = shutil.disk_usage("/").free / 2**30; mp = mempool(); ma = memavail(); fu = faucet(); ch = False
    if free < 8.5 and not os.path.exists("/tmp/r7.HALT"):
        open("/tmp/r7.HALT", "w").write("disk"); ramp(f"HALT all senders: disk {free:.2f} G < 8.5 G")
    if free < 11.0: ch |= setr("disk<11", True, kns=False)
    elif free > 11.5: ch |= setr("disk<11", False, kns=False)
    if free < 10.0: ch |= setr("disk<10", True)
    elif free > 10.5: ch |= setr("disk<10", False)
    if mp is not None and mp > 90000: ch |= setr("mempool>90k", True)
    elif mp is not None and mp < 60000: ch |= setr("mempool>90k", False)
    if ma < 1.0: ch |= setr("ram<1G", True)
    elif ma > 1.5: ch |= setr("ram<1G", False)
    if fu is not None and fu < 1500: low_since = low_since or time.time()
    elif fu is not None and fu > 5000: low_since = None; ch |= setr("funds<1.5k", False)
    if low_since and time.time() - low_since > 600: ch |= setr("funds<1.5k", True)
    if prune == "none" and at(18, 30) <= t < at(21, 0):
        prune = "paused"; ch |= setr("pruning", True)
        for c in (["npm", "cache", "clean", "--force"], ["rm", "-rf", "/home/box/.cache/pip"]):
            try: subprocess.run(c, timeout=120, capture_output=True)
            except Exception: pass
        ramp(f"18:30 pruning pause; caches cleaned; free {shutil.disk_usage('/').free/2**30:.2f} G")
    if prune == "paused" and t >= at(18, 45):
        pid = n0_pid()
        if free < 20 and pid:
            ramp(f"18:45 free {free:.2f} G < 20 G -> SIGINT n0 pid {pid}; n0 stays STOPPED pending user decision")
            os.kill(pid, signal.SIGINT)
            for _ in range(180):
                if not os.path.exists(f"/proc/{pid}"): break
                time.sleep(1)
            ramp(f"n0 exited={not os.path.exists(f'/proc/{pid}')}, free {shutil.disk_usage('/').free/2**30:.2f} G"); prune = "node_stopped"
        else: prune = "watching"; ramp(f"18:45 free {free:.2f} G >= 20 G -> n0 kept running through pruning")
    if prune == "watching":
        try:
            with open(NLOG, "rb") as f:
                f.seek(max(0, os.path.getsize(NLOG) - 20_000_000)); data = f.read().decode(errors="ignore")
            done = [m for m in re.finditer(r"^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d).*(SMT pruning complete|Header and Block pruning completed)", data, re.M)
                    if dt.datetime.strptime(m.group(1), "%Y-%m-%d %H:%M:%S") >= at(18, 25)]
        except Exception: done = []
        if (done and (t - dt.datetime.strptime(done[-1].group(1), "%Y-%m-%d %H:%M:%S")).total_seconds() > 300 and free > 13) or (t >= at(19, 45) and free > 15):
            prune = "resumed"; ch |= setr("pruning", False); ramp(f"pruning settled/fallback, free {free:.2f} G -> resume")
    if ch or time.time() - last_apply > 60: apply(); last_apply = time.time()
    log({"free_gb": round(free, 2), "mp": mp, "mem_gb": round(ma, 2), "faucet": fu, "games_paused": sorted(game_reasons), "kns_paused": sorted(kns_reasons), "prune": prune, "n0": n0_pid()})
    time.sleep(15)
