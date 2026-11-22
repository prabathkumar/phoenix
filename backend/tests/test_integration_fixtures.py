"""Real integration runs against tiny fixture projects that follow each language's convention."""
import os, shutil
import pytest
from phoenix_api import test_connectors as T

FX = os.path.join(os.path.dirname(__file__), "fixtures", "integration")


@pytest.mark.skipif(not shutil.which("python3"), reason="python3 missing")
def test_python_integration_runs_only_the_marked_test():
    r = T.run_tests("python", "integration", os.path.join(FX, "py"))
    assert r["ok"] and [t["name"] for t in r["tests"]] == ["test_calc test_add_integration"]


@pytest.mark.skipif(not shutil.which("go"), reason="go missing")
def test_go_integration_uses_the_build_tag():
    assert len(T.run_tests("go", "unit", os.path.join(FX, "go"))["tests"]) == 1
    r = T.run_tests("go", "integration", os.path.join(FX, "go"))
    assert r["ok"] and any("Integration" in t["name"] for t in r["tests"])
