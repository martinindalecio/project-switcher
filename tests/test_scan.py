import importlib.util, json, os, shutil, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
TMP = tempfile.mkdtemp()
os.environ["PROJECT_SWITCHER_ROOT"] = TMP
spec = importlib.util.spec_from_file_location("scan", os.path.join(HERE, "..", "bin", "scan.py"))
scan = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scan)

SID = "11111111-2222-3333-4444-555555555555"
SID2 = "aaaaaaaa-2222-3333-4444-555555555555"


def asst(tokens=(1, 2, 3), model="claude-x", side=False, stop="end_turn"):
    return {"type": "assistant", "isSidechain": side, "message": {
        "model": model, "stop_reason": stop,
        "usage": {"input_tokens": tokens[0], "cache_read_input_tokens": tokens[1], "cache_creation_input_tokens": tokens[2]}}}


def user(text, meta=False, cwd=None):
    d = {"type": "user", "isMeta": meta, "message": {"role": "user", "content": text}}
    if cwd: d["cwd"] = cwd
    return d


class Base(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        scan.ROOT = self.root
        scan.open_processes = lambda: []

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def write(self, d, sid, entries, raw=None):
        os.makedirs(os.path.join(self.root, d), exist_ok=True)
        p = os.path.join(self.root, d, sid + ".jsonl")
        with open(p, "w") as f:
            for e in entries: f.write((e if isinstance(e, str) else json.dumps(e)) + "\n")
        return p

    def snap(self_, **kw):
        a = {"mode": "once", "self": "", "window": 0, "per": 5, "windows": {}}
        a.update(kw)
        return scan.snapshot(a)

    def sess(self_, **kw):
        return self_.snap(**kw)["projects"][0]["sessions"][0]


class TestTitle(Base):
    def title(self, entries):
        return scan.read_session(self.write("-p", SID, entries))["title"]

    def test_precedence(self):
        u = user("first prompt")
        lp = {"type": "last-prompt", "lastPrompt": "last prompt"}
        ai = {"type": "ai-title", "aiTitle": "ai title"}
        ct = {"type": "custom-title", "customTitle": "custom"}
        self.assertEqual(self.title([u, lp, ai, ct]), "custom")
        self.assertEqual(self.title([u, ct, lp, ai]), "custom")
        self.assertEqual(self.title([u, ct, ai, lp]), "custom")
        self.assertEqual(self.title([u, lp, ai]), "ai title")
        self.assertEqual(self.title([u, ai, lp]), "ai title")
        self.assertEqual(self.title([u, lp]), "last prompt")
        self.assertEqual(self.title([user("<cmd>x"), user("meta", meta=True), u]), "first prompt")

    def test_untitled(self):
        self.write("-p", SID, [asst()])
        self.assertEqual(self.sess()["title"], "(untitled)")


class TestTokens(Base):
    def read(self, entries): return scan.read_session(self.write("-p", SID, entries))

    def test_sum_and_last(self):
        s = self.read([asst((1, 1, 1), "a"), asst((10, 20, 30), "b")])
        self.assertEqual((s["tokens"], s["model"]), (60, "b"))

    def test_synthetic_and_sidechain_skipped(self):
        s = self.read([asst((1, 2, 3), "real"), asst((9, 9, 9), "<synthetic>"), asst((50, 50, 50), "side", side=True)])
        self.assertEqual((s["tokens"], s["model"]), (6, "real"))

    def test_corrupt_line(self):
        s = self.read([user("hello"), "{not json", asst((1, 1, 1)), "}}}"])
        self.assertEqual(s["tokens"], 3)
        self.assertEqual(s["title"], "hello")


class TestWindows(Base):
    def test_window_for(self):
        wf = scan.window_for
        self.assertEqual(wf("m[1m]", 5, {}, None, 0), (1_000_000, True))
        self.assertEqual(wf("m", 5, {"m": 500_000}, None, 0), (500_000, True))
        self.assertEqual(wf("m", 5, {}, "m", 400_000), (400_000, True))
        self.assertEqual(wf("m", 5, {}, "other", 400_000), (200_000, False))
        self.assertEqual(wf("m", 5, {}, "m", 0), (200_000, False))
        self.assertEqual(wf(None, None, {}, None, 0), (200_000, False))
        self.assertEqual(wf("m", 250_000, {}, None, 0), (1_000_000, True))
        self.assertEqual(wf("m", 450_000, {"m": 400_000}, None, 0), (1_000_000, True))

    def test_snapshot_fields(self):
        self.write("-p", SID, [user("hi", cwd="/w/app"), asst((1, 1, 1), "claude-x")])
        s = self.sess()
        self.assertEqual((s["window"], s["windowKnown"]), (200_000, False))
        sn = self.snap(windows={"claude-x": 300_000})
        self.assertEqual(sn["projects"][0]["sessions"][0]["window"], 300_000)
        self.assertTrue(sn["projects"][0]["sessions"][0]["windowKnown"])
        self.assertEqual(sn["windows"], {"claude-x": 300_000})

    def test_self_window_in_windows(self):
        self.write("-p", SID, [asst((1, 1, 1), "claude-x")])
        sn = self.snap(**{"self": SID, "window": 123_000, "windows": {"o": 5}})
        self.assertEqual(sn["windows"], {"o": 5, "claude-x": 123_000})
        self.assertEqual(sn["projects"][0]["sessions"][0]["window"], 123_000)
        self.assertEqual(self.snap(**{"self": SID})["windows"], {})

    def test_args_windows(self):
        import sys
        old = sys.argv
        try:
            sys.argv = ["scan.py", "once", "--windows", '{"a": 1000, "b": "x"}']
            self.assertEqual(scan.args()["windows"], {"a": 1000})
            sys.argv = ["scan.py", "once", "--windows", "garbage"]
            self.assertEqual(scan.args()["windows"], {})
        finally: sys.argv = old


class TestRoot(Base):
    def test_missing_root(self):
        scan.ROOT = os.path.join(self.root, "nope")
        self.assertEqual(self.snap()["projects"], [])
        self.assertEqual(scan.mtimes(), {})

    def test_non_uuid_ignored(self):
        self.write("-p", "x; rm -rf ~", [asst()])
        self.write("-p", "not-a-uuid", [asst()])
        self.assertEqual(self.snap()["projects"], [])
        self.assertEqual(scan.mtimes(), {})
        self.write("-p", SID, [asst()])
        self.assertEqual(len(scan.mtimes()), 1)
        self.assertEqual([s["id"] for s in self.snap()["projects"][0]["sessions"]], [SID])


class TestNames(Base):
    def test_collision(self):
        self.write("-a", SID, [user("x", cwd="/work/app")])
        self.write("-b", SID2, [user("x", cwd="/play/app")])
        self.write("-c", "bbbbbbbb-2222-3333-4444-555555555555", [user("x", cwd="/work/solo")])
        names = {p["path"]: p["name"] for p in self.snap()["projects"]}
        self.assertEqual(names, {"/work/app": "work/app", "/play/app": "play/app", "/work/solo": "solo"})

    def test_path_known(self):
        self.write("-a-b", SID, [user("x", cwd="/real/path")])
        self.write("-c-d", SID2, [asst()])
        pk = {p["dir"]: (p["path"], p["pathKnown"]) for p in self.snap()["projects"]}
        self.assertEqual(pk["-a-b"], ("/real/path", True))
        self.assertEqual(pk["-c-d"], ("/c/d", False))


class TestRobust(Base):
    def test_read_session_vanished(self):
        self.assertIsNone(scan.read_session(os.path.join(self.root, "gone.jsonl")))


if __name__ == "__main__":
    unittest.main()
