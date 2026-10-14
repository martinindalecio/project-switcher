#!/usr/bin/env python3
"""Scan ~/.claude/projects for sessions and their context fill.

  scan.py once  --self <session-id> --self-window <tokens>
  scan.py watch --self <session-id> --self-window <tokens>

`once` prints one JSON snapshot. `watch` prints a snapshot at start, then a new
one each time a transcript's last entry becomes a finished assistant message
(a message ended) or the set of open sessions changes.
"""
import json, os, re, subprocess, sys, time

ROOT = os.environ.get("PROJECT_SWITCHER_ROOT") or os.path.expanduser("~/.claude/projects")
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
PER_PROJECT = 5
TAIL = 512 * 1024
HEAD = 64 * 1024


def args():
    a = {"mode": sys.argv[1] if len(sys.argv) > 1 else "once", "self": "", "window": 0, "per": PER_PROJECT, "windows": {}}
    it = iter(sys.argv[2:])
    for k in it:
        if k == "--self": a["self"] = next(it, "")
        elif k == "--self-window": a["window"] = int(next(it, "0") or 0)
        elif k == "--windows": a["windows"] = parse_windows(next(it, ""))
        elif k == "--per-project": a["per"] = max(1, int(next(it, "0") or PER_PROJECT))
    return a


def parse_windows(raw):
    try: d = json.loads(raw or "{}")
    except Exception: return {}
    if not isinstance(d, dict): return {}
    return {k: v for k, v in d.items() if isinstance(k, str) and isinstance(v, int) and not isinstance(v, bool) and v > 0}


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
    try:
        size = os.path.getsize(path)
        tail = lines_of(path, max(0, size - TAIL), TAIL)
    except OSError:
        return None  # file vanished
    custom = ai = None
    s = {"tokens": None, "model": None, "title": None, "cwd": None, "ended": False}
    for d in reversed(tail):
        t = d.get("type")
        if s["cwd"] is None and d.get("cwd"): s["cwd"] = d["cwd"]
        if custom is None and t == "custom-title": custom = d.get("customTitle") or None
        if ai is None and t == "ai-title": ai = d.get("aiTitle") or d.get("title") or None
        if s["tokens"] is None and t == "assistant" and not d.get("isSidechain"):
            m = d.get("message") or {}
            u = m.get("usage") or {}
            if u and m.get("model") != "<synthetic>":
                s["tokens"] = (u.get("input_tokens", 0) + u.get("cache_read_input_tokens", 0)
                               + u.get("cache_creation_input_tokens", 0))
                s["model"] = m.get("model")
    s["title"] = custom or ai
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
        try: head = lines_of(path, 0, HEAD)
        except OSError: head = []
        for d in head:
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


def window_for(model, tokens, learned, self_model, self_window):
    """(window, known): known is False only when we fell back to the 200k guess."""
    if model and "[1m]" in model: return 1_000_000, True
    if model and model in learned: w, known = learned[model], True
    elif model and model == self_model and self_window: w, known = self_window, True
    else: w, known = 200_000, False
    if tokens and tokens > w: w, known = 1_000_000, True
    return w, known


def transcript_id(f):
    stem = f[:-6] if f.endswith(".jsonl") else ""
    return stem if UUID_RE.match(stem) else None


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
            if transcript_id(f):
                p = os.path.join(pdir, f)
                try: files.append((os.path.getmtime(p), f[:-6], p))
                except OSError: pass
        if not files: continue
        files.sort(reverse=True)
        projects.append({"dir": d, "files": files})
        for _, sid, p in files:
            if sid == a["self"]:
                cache[sid] = read_session(p)
                if cache[sid]: self_model = cache[sid]["model"]

    result = []
    for pr in projects:
        files = pr["files"]
        newest = None
        for _, sid, p in files:
            newest = cache.get(sid) or read_session(p)
            if newest: cache[sid] = newest; break
        if not newest: continue
        path_known = bool(newest["cwd"])
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
            if not s: continue
            w, known = window_for(s["model"], s["tokens"], a["windows"], self_model, a["window"])
            sessions.append({
                "id": sid, "title": s["title"] or "(untitled)", "cwd": s["cwd"] or path,
                "tokens": s["tokens"], "window": w, "windowKnown": known, "model": s["model"],
                "mtimeMs": int(mt * 1000), "isOpen": sid in open_ids or sid in cwd_open or sid == a["self"],
                "isSelf": sid == a["self"],
                "inDesktop": open_ids.get(sid, cwd_open.get(sid, False)),
            })
        result.append({
            "dir": pr["dir"], "name": os.path.basename(path.rstrip("/")) or path, "path": path, "pathKnown": path_known,
            "total": len(files), "mtimeMs": int(files[0][0] * 1000), "sessions": sessions,
        })
    names = [r["name"] for r in result]
    for r in result:
        if names.count(r["name"]) > 1:
            r["name"] = (os.path.basename(os.path.dirname(r["path"].rstrip("/"))) or "") + "/" + r["name"]
    result.sort(key=lambda r: r["mtimeMs"], reverse=True)
    windows = dict(a["windows"])
    if self_model and a["window"]: windows[self_model] = a["window"]
    return {"at": int(time.time() * 1000), "projects": result, "windows": windows}


def out(obj):
    sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def emit(a):
    try: out(snapshot(a))
    except Exception as e: out({"error": "scan failed: %s" % (str(e) or type(e).__name__)[:200]})


def mtimes():
    m = {}
    if not os.path.isdir(ROOT): return m
    for d in os.listdir(ROOT):
        pdir = os.path.join(ROOT, d)
        if not os.path.isdir(pdir): continue
        for f in os.listdir(pdir):
            if transcript_id(f):
                p = os.path.join(pdir, f)
                try: m[p] = os.path.getmtime(p)
                except OSError: pass
    return m


def watch(a):
    emit(a)
    try: seen = mtimes()
    except Exception: seen = {}
    opened, last_proc = None, 0
    while True:
        time.sleep(1.5)
        try:
            now = mtimes()
            changed = [p for p, t in now.items() if seen.get(p) != t]
            seen = now
            fire = any((read_session(p) or {}).get("ended") for p in changed)
            if time.time() - last_proc > 15:  # open/closed sessions, checked less often
                last_proc = time.time()
                ids = sorted((p[0] or "", p[1] or "") for p in open_processes())
                if opened is not None and ids != opened: fire = True
                opened = ids
            if fire: emit(a)
        except Exception as e:
            out({"error": "watch failed: %s" % (str(e) or type(e).__name__)[:200]})


if __name__ == "__main__":
    a = args()
    watch(a) if a["mode"] == "watch" else emit(a)
