"""Real toolchains, real sample projects: each language gets one unit and one integration test (one failing on purpose in python) tagged with requirement keys.
A language whose toolchain is not installed is SKIPPED with the reason, never counted as a pass. dotnet is not installed in the sandbox; PHP needs phpunit."""
import json
import os
import re
import shutil
import subprocess

import pytest

from phoenix_api import test_connectors as tc


def need(lang):
    if not shutil.which(tc.TOOL[lang]):
        pytest.skip(f"{tc.TOOL[lang]} is not installed")


def write(root, files):
    for f, body in files.items():
        os.makedirs(os.path.dirname(os.path.join(root, f)) or root, exist_ok=True)
        open(os.path.join(root, f), "w").write(body)


def check(r, passed, failed=0):
    assert r["available"], r["detail"]
    assert r["summary"]["passed"] == passed and r["summary"]["failed"] == failed, r["detail"]


def test_python_unit_and_integration_with_a_real_failure(tmp_path):
    need("python")
    write(tmp_path, {"pytest.ini": "[pytest]\nmarkers = integration: integration tests\n", "test_a.py": '''import pytest
def test_PROJ_1_adds(): assert 1 + 1 == 2
def test_PROJ_2_fails(): assert 1 + 1 == 3
@pytest.mark.integration
def test_PROJ_3_end_to_end(): assert True
'''})
    u = tc.run_tests("python", "unit", str(tmp_path))
    i = tc.run_tests("python", "integration", str(tmp_path))
    check(u, 1, 1); check(i, 1)
    assert not u["ok"] and i["ok"]
    assert i["tests"][0]["name"].endswith("test_PROJ_3_end_to_end")


def test_javascript_unit_and_integration(tmp_path):
    need("javascript")
    write(tmp_path, {"package.json": "{}", "a.test.js": "const t=require('node:test');const a=require('node:assert');t('PROJ-4 adds',()=>a.strictEqual(1+1,2));",
                     "b.integration.test.js": "const t=require('node:test');const a=require('node:assert');t('PROJ-5 flow',()=>a.ok(true));"})
    u, i = tc.run_tests("javascript", "unit", str(tmp_path)), tc.run_tests("javascript", "integration", str(tmp_path))
    assert u["summary"]["total"] >= 1 and i["summary"]["passed"] == 1, (u["detail"], i["detail"])
    assert "PROJ-5" in i["summary"]["requirements"]


def test_go_unit_and_integration_by_build_tag(tmp_path):
    need("go")
    write(tmp_path, {"go.mod": "module ex\n\ngo 1.21\n", "a_test.go": 'package ex\nimport "testing"\nfunc TestREQ_1Adds(t *testing.T){ if 1+1!=2 {t.Fatal("x")} }\n',
                     "b_test.go": '//go:build integration\n\npackage ex\nimport "testing"\nfunc TestREQ_2Flow(t *testing.T){}\n'})
    u, i = tc.run_tests("go", "unit", str(tmp_path)), tc.run_tests("go", "integration", str(tmp_path))
    check(u, 1); assert u["summary"]["requirements"] == ["REQ-1"]
    assert i["summary"]["passed"] == 2 and "REQ-2" in i["summary"]["requirements"]  # integration run includes the tagged tests


def test_java_unit_via_maven_if_the_repo_is_resolvable(tmp_path):
    need("java")
    if subprocess.run(["mvn", "-v"], capture_output=True).returncode != 0:
        pytest.skip("mvn does not run")
    write(tmp_path, {"pom.xml": '''<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion><groupId>ex</groupId><artifactId>ex</artifactId><version>1</version>
<properties><maven.compiler.source>17</maven.compiler.source><maven.compiler.target>17</maven.compiler.target></properties>
<dependencies><dependency><groupId>org.junit.jupiter</groupId><artifactId>junit-jupiter</artifactId><version>5.10.2</version><scope>test</scope></dependency></dependencies>
<build><plugins><plugin><artifactId>maven-surefire-plugin</artifactId><version>3.2.5</version></plugin></plugins></build></project>''',
                     "src/test/java/ex/ATest.java": 'package ex; import org.junit.jupiter.api.Test; import static org.junit.jupiter.api.Assertions.*; public class ATest { @Test void PROJ_9_adds(){ assertEquals(2,1+1);} }'})
    r = tc.run_tests("java", "unit", str(tmp_path), timeout=240)
    if not r["tests"] and re.search(r"PluginResolution|Could not transfer|resolve|offline|Unknown host|UnknownHost", r["detail"], re.I):
        pytest.skip("maven cannot download its plugins here (no network to the Maven repository)")
    check(r, 1)


def test_php_is_available_and_reports_honestly_without_phpunit(tmp_path):
    need("php")
    write(tmp_path, {"composer.json": "{}"})
    assert "php" in tc.detect_languages(str(tmp_path))
    r = tc.run_tests("php", "unit", str(tmp_path))
    assert r["available"] and not r["ok"]  # no phpunit installed here: a clear 'no result', never a pass
    assert r["tests"] == [] and "no unit tests" in r["detail"]


def test_missing_toolchain_is_reported_not_passed(tmp_path):
    r = tc.run_tests("csharp", "unit", str(tmp_path), which=lambda t: None)
    assert r["available"] is False and r["ok"] is False and r["summary"]["total"] == 0


def test_run_all_detects_languages_and_runs_both_kinds(tmp_path):
    need("python")
    write(tmp_path, {"pytest.ini": "[pytest]\nmarkers = integration: x\n", "requirements.txt": "", "test_a.py": "import pytest\ndef test_REQ_1(): pass\n@pytest.mark.integration\ndef test_REQ_2(): pass\n"})
    rs = tc.run_all(str(tmp_path))
    assert {(r["language"], r["kind"]) for r in rs} == {("python", "unit"), ("python", "integration")} and all(r["ok"] for r in rs)
