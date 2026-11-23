import json
import subprocess
import sys

from phoenix_api import integration_flow as f


def _repo(tmp_path):
    (tmp_path / "app.py").write_text(
        '@app.get("/orders")\ndef a(): pass\n@router.post("/orders/new")\ndef b(): pass\n'
        'r = requests.get("https://pay.example.com/charge")\n')
    (tmp_path / "web.js").write_text('app.delete("/cart/:id", h)\nfetch("https://x.example.com/ping")\n')
    (tmp_path / "openapi.json").write_text(json.dumps({"paths": {
        "/charge": {"get": {"responses": {"200": {"content": {"application/json": {"example": {"paid": True}}}}}}},
        "/health": {"get": {"summary": "up"}}}}))
    return str(tmp_path)


def test_discover(tmp_path):
    d = f.discover(_repo(tmp_path))
    ins = {(i["method"], i["path"]) for i in d["inbound"]}
    assert ("GET", "/orders") in ins and ("POST", "/orders/new") in ins and ("DELETE", "/cart/:id") in ins and ("GET", "/health") in ins
    outs = {o["url"] for o in d["outbound"]}
    assert outs == {"https://pay.example.com/charge", "https://x.example.com/ping"}
    assert d["openapi"]


def test_mock_uses_openapi_example(tmp_path):
    d = f.discover(_repo(tmp_path))
    m = f.mock_for({"method": "GET", "url": "https://pay.example.com/charge"}, d["spec"])
    assert m == {"status": 200, "body": {"paid": True}}
    assert f.mock_for({"method": "GET", "url": "https://zzz.com/none"}, d["spec"])["body"] == {"ok": True}


def test_cases_draft_and_model(tmp_path):
    d = f.discover(_repo(tmp_path))
    reqs = [{"key": "R-1", "title": "List orders", "description": "orders list"}, {"key": "R-2", "title": "zzzz", "description": ""}]
    cs = f.build_cases(d, reqs)
    assert cs[0]["path"] == "/orders" and cs[0]["source"].startswith("draft")
    cs = f.build_cases(d, reqs, call_json=lambda t: {"cases": [{"requirement": "R-2", "method": "POST", "path": "/orders/new", "input": {"a": 1}, "expected": {"status": 201}}]})
    by = {c["requirement"]: c for c in cs}
    assert by["R-2"]["source"] == "model" and by["R-1"]["source"].startswith("draft")
    assert by["R-2"]["mocks"]


def test_generated_pytest_skips_without_base(tmp_path):
    d = f.discover(_repo(tmp_path))
    cs = f.build_cases(d, [{"key": "R-1", "title": "orders", "description": ""}])
    p = tmp_path / "test_gen.py"
    p.write_text(f.to_pytest(cs))
    r = subprocess.run([sys.executable, "-m", "pytest", str(p), "-q", "-rs", "-p", "no:cacheprovider"], capture_output=True, text=True, cwd=str(tmp_path))
    assert "1 skipped" in r.stdout, r.stdout + r.stderr


def test_async_model_callable(tmp_path):
    async def model(text):
        return {"cases": [{"requirement": "R-1", "method": "GET", "path": "/orders", "input": {}, "expected": {"status": 200}}]}
    cs = f.build_cases(f.discover(_repo(tmp_path)), [{"key": "R-1", "title": "x", "description": ""}], call_json=model)
    assert cs[0]["source"] == "model"
