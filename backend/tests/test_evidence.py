import asyncio, json, os, sys, tarfile, io
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from phoenix_api import evidence as E, handlers as H  # noqa: E402

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 200 + b"\x00\x00\x00\x00IEND\xaeB`\x82"


def setup(tmp_path):
    r, s = tmp_path / "reports", tmp_path / "shots"
    r.mkdir(); s.mkdir()
    (r / "a.json").write_text(json.dumps({"token": "Bearer abcdef1234567890abcdef", "ok": 1}))
    (r / "x.har").write_text(json.dumps({"log": {"entries": []}}))
    (s / "1.png").write_bytes(PNG)
    (s / "bad.png").write_bytes(b"\x89PNG\r\n\x1a\n" + b"x" * 300)   # cut off: no IEND
    return [str(r), str(s)]


def test_bundle_masks_validates_and_catches_damage(tmp_path):
    b = E.bundle("run-1", setup(tmp_path), str(tmp_path / "out"), {"data.json": '{"password": "hunter2hunter2"}'})
    assert b["files"] == 5 and b["ratio"]
    v = E.validate(b["path"])
    assert not v["ok"] and any("bad.png" in p and "image" in p for p in v["problems"]) and v["screenshots"] == 2
    assert not any("secret" in p for p in v["problems"]), "secrets were masked before packing"
    raw = tarfile.open(b["path"]).extractfile("reports/a.json").read().decode()
    assert "abcdef1234567890" not in raw
    # damage: flip a byte inside a file listed in the manifest
    with tarfile.open(b["path"]) as t:
        mem = {m.name: t.extractfile(m).read() for m in t.getmembers()}
    mem["reports/x.har"] = b'{"log": {"entries": [1]}}'
    bad = tmp_path / "bad.tar.gz"
    with tarfile.open(bad, "w:gz") as t:
        for n, d in mem.items():
            ti = tarfile.TarInfo(n); ti.size = len(d); t.addfile(ti, io.BytesIO(d))
    assert any("damaged" in p for p in E.validate(str(bad))["problems"])
    assert not E.validate(str(tmp_path / "nope.tar.gz"))["ok"]


def test_symlinks_are_not_followed_and_good_set_passes(tmp_path):
    d = tmp_path / "r"; d.mkdir()
    (d / "ok.json").write_text("{}")
    (tmp_path / "secret.json").write_text('{"k":1}')
    os.symlink(tmp_path / "secret.json", d / "link.json")
    b = E.bundle("r2", [str(d)], str(tmp_path / "o"))
    assert [f["name"] for f in b["manifest"]] == ["r/ok.json"] and E.validate(b["path"])["ok"]


def test_handler_and_ai_digest(tmp_path):
    dirs = setup(tmp_path)[:1]
    r = asyncio.run(H.evidence_handler("p", "run-9", {"PHOENIX_EVIDENCE_DIR": str(tmp_path / "ev")}, dirs)({"results": [{"id": "execution", "status": "failed", "detail": "x"}], "goal": "g"}))
    assert r["ok"] and "training capture is off" in r["detail"] and os.path.exists(r["data"]["archive"])
    dg = E.digest([{"kind": "report"}], [{"id": "execution", "status": "failed"}])
    assert dg["failed"] == ["execution"]
