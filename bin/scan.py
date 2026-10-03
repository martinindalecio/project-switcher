#!/usr/bin/env python3
"""Scan ~/.claude/projects for sessions and their context fill.

  scan.py once  --self <session-id> --self-window <tokens>
  scan.py watch --self <session-id> --self-window <tokens>

`once` prints one JSON snapshot. `watch` prints a snapshot at start, then a new
one each time a transcript's last entry becomes a finished assistant message
(a message ended) or the set of open sessions changes.
"""
import json, os, re, subprocess, sys, time

ROOT = os.path.expanduser("~/.claude/projects")
PER_PROJECT = 5
TAIL = 512 * 1024
HEAD = 64 * 1024


def args():
    a = {"mode": sys.argv[1] if len(sys.argv) > 1 else "once", "self": "", "window": 0, "per": PER_PROJECT}
    it = iter(sys.argv[2:])
    for k in it:
        if k == "--self": a["self"] = next(it, "")
        elif k == "--self-window": a["window"] = int(next(it, "0") or 0)
        elif k == "--per-project": a["per"] = max(1, int(next(it, "0") or PER_PROJECT))
    return a


def lines_of(path, start, size):
    with open(path, "rb") as f:
        f.seek(start)
        raw = f.read(size)
    out = []
    for ln in raw.split(b"\n"):
        try: out.append(json.loads(ln))
        except Exception: pass
    return out


def text_of(msg):
    c = (msg or {}).get("content")
    if isinstance(c, str): return c
    if isinstance(c, list):
        for b in c:
            if isinstance(b, dict) and b.get("type") == "text": return b.get("text", "")
    return ""


def read_session(path):
    size = os.path.getsize(path)
    tail = lines_of(path, max(0, size - TAIL), TAIL)
    s = {"tokens": None, "model": None, "title": None, "cwd": None, "ended": False}
    for d in reversed(tail):
        t = d.get("type")
        if s["cwd"] is None and d.get("cwd"): s["cwd"] = d["cwd"]
        if s["title"] is None and t == "custom-title": s["title"] = d.get("customTitle")
        if s["title"] is None and t == "ai-title": s["title"] = d.get("aiTitle") or d.get("title")
        if s["tokens"] is None and t == "assistant" and not d.get("isSidechain"):
            m = d.get("message") or {}
            u = m.get("usage") or {}
            if u and m.get("model") != "<synthetic>":
                s["tokens"] = (u.get("input_tokens", 0) + u.get("cache_read_input_tokens", 0)
                               + u.get("cache_creation_input_tokens", 0))
                s["model"] = m.get("model")
    # last real message: did the assistant finish its turn?
    for d in reversed(tail):
        if d.get("type") in ("user", "assistant") and not d.get("isSidechain"):
            m = d.get("message") or {}
            s["ended"] = d["type"] == "assistant" and m.get("stop_reason") == "end_turn"
            break
    if s["title"] is None:
        for d in reversed(tail):
            if d.get("type") == "last-prompt" and d.get("lastPrompt"):
                s["title"] = d["lastPrompt"]; break
    if s["title"] is None or s["cwd"] is None:
        for d in lines_of(path, 0, HEAD):
            if s["cwd"] is None and d.get("cwd"): s["cwd"] = d["cwd"]
            if s["title"] is None and d.get("type") == "user" and not d.get("isMeta"):
                txt = text_of(d.get("message")).strip()
                if txt and not txt.startswith("<"): s["title"] = txt
            if s["title"] and s["cwd"]: break
    if s["title"]:
        s["title"] = re.sub(r"\s+", " ", s["title"]).strip()[:90]
    return s


def open_processes():
    """[(resume_id or None, cwd, started_epoch)] for running claude sessions."""
    out = []
    try:
        ps = subprocess.run(["ps", "-axo", "pid=,lstart=,command="], capture_output=True, text=True, timeout=5).stdout
    except Exception:
        return out
    for line in ps.splitlines():
        m = re.match(r"\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)", line)
        if not m: continue
        pid, lstart, cmd = m.groups()
        exe = cmd.split(" --", 1)[0]
        if "disclaimer" in exe or not (exe.endswith("/claude") or exe == "claude"): continue
        rid = re.search(r"--resume[= ]([0-9a-f-]{36})", cmd)
        cwd = None
        try:
            l = subprocess.run(["lsof", "-a", "-p", pid, "-d", "cwd", "-Fn"], capture_output=True, text=True, timeout=5).stdout
            cwd = next((x[1:] for x in l.splitlines() if x.startswith("n")), None)
        except Exception: pass
        try: started = time.mktime(time.strptime(lstart, "%a %b %d %H:%M:%S %Y"))
        except Exception: started = 0
        # the Desktop app drives its sessions over stream-json; a terminal session never does
        desktop = "--input-format stream-json" in cmd
        out.append((rid.group(1) if rid else None, cwd, started, desktop))
    return out


def window_for(model, tokens, self_model, self_window):
    if model and "[1m]" in model: return 1_000_000
    if model and model == self_model and self_window: w = self_window
    else: w = 200_000
    if tokens and tokens > w: w = 1_000_000
    return w


def snapshot(a):
    procs = open_processes()
    open_ids = {p[0]: p[3] for p in procs if p[0]}
    open_cwds = [(p[1], p[2], p[3]) for p in procs if not p[0] and p[1]]
    projects, self_model = [], None
    cache = {}

    dirs = [d for d in os.listdir(ROOT) if os.path.isdir(os.path.join(ROOT, d))] if os.path.isdir(ROOT) else []
    for d in dirs:
        pdir = os.path.join(ROOT, d)
        files = []
        for f in os.listdir(pdir):
            if f.endswith(".jsonl"):
                p = os.path.join(pdir, f)
                try: files.append((os.path.getmtime(p), f[:-6], p))
                except OSError: pass
        if not files: continue
        files.sort(reverse=True)
        projects.append({"dir": d, "files": files})
        for _, sid, p in files:
            if sid == a["self"]:
                cache[sid] = read_session(p); self_model = cache[sid]["model"]

    result = []
    for pr in projects:
        files = pr["files"]
        newest = cache.get(files[0][1]) or read_session(files[0][2])
        cache[files[0][1]] = newest
        path = newest["cwd"] or "/" + pr["dir"].lstrip("-").replace("-", "/")
        # sessions opened without --resume: the newest transcript in that cwd written since the process started
        cwd_open = {}
        for cwd, started, desktop in open_cwds:
            if cwd == path:
                for mt, sid, _ in files:
                    if mt >= started - 5 and sid not in cwd_open: cwd_open[sid] = desktop; break
        picked = files[:a["per"]] + [f for f in files[a["per"]:] if f[1] in open_ids or f[1] in cwd_open or f[1] == a["self"]]
        sessions = []
        for mt, sid, p in picked:
            s = cache.get(sid) or read_session(p)
            w = window_for(s["model"], s["tokens"], self_model, a["window"])
            sessions.append({
                "id": sid, "title": s["title"] or "(untitled)", "cwd": s["cwd"] or path,
                "tokens": s["tokens"], "window": w, "model": s["model"],
                "mtimeMs": int(mt * 1000), "isOpen": sid in open_ids or sid in cwd_open or sid == a["self"],
                "isSelf": sid == a["self"],
                "inDesktop": open_ids.get(sid, cwd_open.get(sid, False)),
            })
        result.append({
            "dir": pr["dir"], "name": os.path.basename(path.rstrip("/")) or path, "path": path,
            "total": len(files), "mtimeMs": int(files[0][0] * 1000), "sessions": sessions,
        })
    result.sort(key=lambda r: r["mtimeMs"], reverse=True)
    return {"at": int(time.time() * 1000), "projects": result}


def emit(a):
    sys.stdout.write(json.dumps(snapshot(a), separators=(",", ":")) + "\n")
    sys.stdout.flush()


def mtimes():
    m = {}
    for d in os.listdir(ROOT):
        pdir = os.path.join(ROOT, d)
        if not os.path.isdir(pdir): continue
        for f in os.listdir(pdir):
            if f.endswith(".jsonl"):
                p = os.path.join(pdir, f)
                try: m[p] = os.path.getmtime(p)
                except OSError: pass
    return m


def watch(a):
    emit(a)
    seen, opened, last_proc = mtimes(), None, 0
    while True:
        time.sleep(1.5)
        now = mtimes()
        changed = [p for p, t in now.items() if seen.get(p) != t]
        seen = now
        fire = any(read_session(p)["ended"] for p in changed if os.path.exists(p))
        if time.time() - last_proc > 15:  # open/closed sessions, checked less often
            last_proc = time.time()
            ids = sorted((p[0] or "", p[1] or "") for p in open_processes())
            if opened is not None and ids != opened: fire = True
            opened = ids
        if fire: emit(a)


if __name__ == "__main__":
    a = args()
    watch(a) if a["mode"] == "watch" else emit(a)
