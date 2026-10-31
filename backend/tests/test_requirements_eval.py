import base64
import io
import json
import sys
import zipfile
from pathlib import Path

import pytest

from phoenix_api import ai_eval, analytics, requirements_loader as RL


def office(files):
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w", zipfile.ZIP_DEFLATED) as z:
        for k, v in files.items():
            z.writestr(k, v)
    return b.getvalue()


def test_office_formats():
    docx = office({"word/document.xml": "<w:p><w:r><w:t>User can log in</w:t></w:r></w:p><w:p><w:r><w:t>Second</w:t></w:r></w:p>"})
    assert "User can log in" in RL.docx_text(docx) and "Second" in RL.docx_text(docx)
    xlsx = office({"xl/sharedStrings.xml": "<sst><si><t>Name</t></si><si><t>Pat</t></si></sst>", "xl/worksheets/sheet1.xml": '<row><c t="s"><v>0</v></c><c><v>42</v></c></row><row><c t="s"><v>1</v></c><c/></row>'})
    t = RL.xlsx_text(xlsx)
    assert "Name | 42" in t and "Pat" in t
    assert "Slide 1" in RL.pptx_text(office({"ppt/slides/slide1.xml": "<a:p><a:r><a:t>Hello</a:t></a:r></a:p>"}))
    assert "GET /pets: List" in RL.json_text(json.dumps({"openapi": "3", "info": {"title": "P"}, "paths": {"/pets": {"get": {"summary": "List"}}}}))
    assert "# Title" in RL.html_text("<html><head><title>T</title><script>x()</script></head><body><h1>Title</h1><p>Body</p></body></html>")


async def test_loader_text_file_and_url():
    r = await RL.load_requirement(file={"name": "r.md", "base64": base64.b64encode(b"# Req\nUser can pay.").decode()})
    assert r["source"]["type"] == "md" and "User can pay" in r["text"]
    async def fetcher(url, allow_private=False): return {"url": url, "type": "text/html", "body": b"<h1>Public req</h1>"}
    u = await RL.load_requirement(url="https://example.com/r", fetcher=fetcher)
    assert u["source"]["host"] == "example.com" and "Public req" in u["text"]
    with pytest.raises(ValueError):
        await RL.load_requirement()


@pytest.mark.parametrize("ip", ["127.0.0.1", "10.0.0.5", "169.254.169.254", "192.168.1.1", "172.16.0.1", "::1", "fe80::1", "100.64.0.1", "::ffff:10.0.0.1"])
def test_private_addresses(ip):
    assert RL.private_address(ip)


@pytest.mark.parametrize("url", ["http://127.0.0.1/x", "http://169.254.169.254/latest/meta-data", "ftp://example.com/x", "http://user:pw@example.com/x", "http://[::1]/x"])
async def test_ssrf_guards(url):
    with pytest.raises(ValueError):
        await RL.fetch_public(url)


async def test_ssrf_dns_to_private_and_redirect_recheck():
    async def to_private(host): return ["10.1.1.1"]
    with pytest.raises(ValueError, match="private"):
        await RL.fetch_public("https://evil.example/x", resolve=to_private)
    calls = []
    async def resolve(host):
        calls.append(host)
        return ["93.184.216.34"] if host == "ok.example" else ["127.0.0.1"]
    import httpx
    def factory():
        return httpx.AsyncClient(transport=httpx.MockTransport(lambda req: httpx.Response(302, headers={"location": "http://internal.example/secret"})))
    with pytest.raises(ValueError, match="private"):
        await RL.fetch_public("https://ok.example/x", resolve=resolve, client_factory=factory)
    assert calls == ["ok.example", "internal.example"]


def test_parse_conversation():
    t = ai_eval.parse_conversation("User: hi\nBot: hello\nthere\nCustomer: refund?\nAssistant: yes within 30 days")
    assert t == [{"input": "hi", "actual_output": "hello\nthere"}, {"input": "refund?", "actual_output": "yes within 30 days"}]


def stub_runner(tmp_path, exit_code=0, results=None):
    script = tmp_path / "stub.py"
    script.write_text("import json,sys\nd=json.load(open(sys.argv[1]));assert 'sk-' not in json.dumps(d)\n"
                      f"sys.exit({exit_code}) if {exit_code} else json.dump({{'results':{(results or [])!r}}},open(sys.argv[2],'w'))\n")
    def run(cmd, **kw):
        import subprocess
        if cmd[:2] == [sys.executable, "-c"]:
            return subprocess.CompletedProcess(cmd, 0, "", "")
        return subprocess.run(cmd, **kw)
    return script, run


def test_evaluate_unavailable_without_judge():
    r = ai_eval.evaluate(conversation="User: a\nBot: b", env={})
    assert r["status"] == "unavailable" or "DeepEval" in r["why"]


def test_evaluate_scores_redacts_and_logs(tmp_path):
    script, run = stub_runner(tmp_path, 0, [{"turn": 0, "metric": "answer_relevancy", "score": 0.9, "passed": True}, {"turn": 0, "metric": "toxicity", "score": 0.7, "passed": False}])
    r = ai_eval.evaluate(conversation="User: my key sk-abcdefghijklmnopqrstuvwx\nBot: ok", env={"DEEPEVAL_OLLAMA_MODEL": "llama3"}, run=run, script=script, run_id="run-x")
    assert r["status"] == "ok" and r["summary"]["failed"] == 1 and r["summary"]["byMetric"]["answer_relevancy"]["avg"] == 0.9
    assert {x["metric"] for x in analytics.default()._rows("ai_eval", 1)} == {"answer_relevancy", "toxicity"}
    script3, run3 = stub_runner(tmp_path, 3)
    assert ai_eval.evaluate(conversation="User: a\nBot: b", env={"OPENAI_API_KEY": "x"}, run=run3, script=script3)["status"] == "unavailable"
    assert ai_eval.evaluate(conversation="User: a\nBot: b", metrics=["geval"], env={})["status"] == "error"
