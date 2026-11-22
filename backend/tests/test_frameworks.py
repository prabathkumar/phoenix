import asyncio
import json
import os

from phoenix_api import handlers as H, test_connectors as T, unit_tests as U


def read_from(files):
    async def read(f):
        return files[f]
    return read


def test_frameworks_are_found_from_the_repo_files_not_guessed():
    pj = json.dumps({"dependencies": {"@angular/core": "18"}})
    assert asyncio.run(U.detect_frameworks(["package.json"], read_from({"package.json": pj}))) == {"typescript": "angular"}
    pj = json.dumps({"dependencies": {"@nestjs/core": "10"}, "devDependencies": {"jest": "29"}})
    assert asyncio.run(U.detect_frameworks(["package.json"], read_from({"package.json": pj}))) == {"typescript": "nestjs"}
    assert asyncio.run(U.detect_frameworks(["requirements.txt"], read_from({"requirements.txt": "fastapi==0.1\nuvicorn\n"}))) == {"python": "fastapi"}
    assert asyncio.run(U.detect_frameworks(["pyproject.toml"], read_from({"pyproject.toml": 'dependencies = ["Django>=5"]'}))) == {"python": "django"}
    assert asyncio.run(U.detect_frameworks(["Cargo.toml"], read_from({"Cargo.toml": '[dependencies]\naxum = "0.7"\n'}))) == {"rust": "axum"}
    assert asyncio.run(U.detect_frameworks(["Cargo.toml"], read_from({"Cargo.toml": '[dependencies]\nactix-web = "4"\n'}))) == {"rust": "actix"}
    assert asyncio.run(U.detect_frameworks(["README.md"], read_from({}))) == {}


def test_every_language_has_a_test_path_a_shape_check_and_a_runner():
    for lang in ("angular", "nestjs"):
        assert U.FRAMEWORKS[lang][0] == "typescript"
    for lang in U.LANGS:
        assert lang in U.SHAPE and lang in T.LANGUAGES and lang in T.TOOL and lang in T.CONVENTIONS, lang
    assert U.language_of("src/app/x.service.ts") == "typescript" and U.language_of("src/main.rs") == "rust" and U.language_of("lib/Foo.pm") == "perl"
    assert U.LANGS["perl"]["test"]("lib/Foo/Bar.pm") == "t/foo_bar.t" and U.IS_TEST.search("t/foo_bar.t")


def test_the_framework_changes_the_prompt_and_the_test_file_name():
    seen = []

    async def call_json(p):
        seen.append(p)
        return {"code": "describe('x', () => { it('works', () => { expect(1).toBe(1); }); });"}
    out = asyncio.run(U.generate_tests(["src/a.service.ts"], read_from({"src/a.service.ts": "export const a = 1;"}), call_json, lambda *a: {"text": "t"}, frameworks={"typescript": "nestjs"}))
    assert out["files"][0]["path"] == "src/a.service.spec.ts" and "@nestjs/testing" in seen[0]


def test_runners_for_nestjs_angular_rust_perl_and_their_result_parsers(tmp_path):
    (tmp_path / "package.json").write_text(json.dumps({"dependencies": {"@nestjs/core": "10"}}))
    argv, _, parser = T.command("typescript", "integration", "/tmp/o.json", str(tmp_path))
    assert argv[:3] == ["npx", "jest", "--ci"] and "test/jest-e2e.json" in argv and parser == "jestjson"
    (tmp_path / "package.json").write_text(json.dumps({"dependencies": {"@angular/core": "18"}}))
    assert T.command("typescript", "unit", "/tmp/o.xml", str(tmp_path))[0][:3] == ["npx", "ng", "test"]
    assert T.command("rust", "integration", "o")[0] == ["cargo", "test", "--test", "integration_*"] and T.command("perl", "unit", "o")[0][0] == "prove"
    assert [t["status"] for t in T.parse_cargo("test a ... ok\ntest b ... FAILED\ntest c ... ignored\n")] == ["passed", "failed", "skipped"]
    assert [(t["name"], t["status"]) for t in T.parse_tap("ok 1 - REQ-7 works\nnot ok 2 - bad\nok 3 # SKIP later\n")] == [("REQ-7 works", "passed"), ("bad", "failed"), ("test", "skipped")]
    j = json.dumps({"testResults": [{"assertionResults": [{"fullName": "REQ-9 adds", "status": "passed", "duration": 3}, {"fullName": "x", "status": "failed"}]}]})
    assert [(t["status"], t["requirement"]) for t in T.parse_jest_json(j)] == [("passed", "REQ-9"), ("failed", "")]


def test_the_run_step_loads_the_written_tests_and_the_data_into_the_checkout(monkeypatch, tmp_path):
    cloned = tmp_path / "co"
    cloned.mkdir()
    seen = {}
    monkeypatch.setattr(T, "clone", lambda url, ref="": str(cloned))
    monkeypatch.setattr(T, "run_all", lambda root, langs, kinds, **kw: seen.update(env=kw.get("env"), files=sorted(os.listdir(os.path.join(root, "tests")))) or [])
    env = {"PHOENIX_UNIT_CLONE_HOSTS": "github.com"}
    h = H.unitrun_handler(env=env)
    rq = {"cloneUrl": "https://github.com/o/a.git", "testFiles": [{"path": "tests/test_x.py", "content": "def test_a(): pass\n"}], "dataEnv": {"CUSTOMER_NAME": "Aisha", "bad name": "x"}}
    asyncio.run(h({"repoRequest": rq}))
    assert seen["files"] == ["test_x.py"] and seen["env"]["CUSTOMER_NAME"] == "Aisha" and "bad name" not in seen["env"]
    out = asyncio.run(h({"repoRequest": {**rq, "testFiles": [{"path": "../evil.py", "content": "x"}]}}))
    assert out["unavailable"] and "unsafe path" in out["detail"]
