import os

import pytest

from phoenix_api import proof as P, test_connectors as T, unit_tests as U

CODE = "def add(a, b):\n    return a + b\n\n\ndef sub(a, b):\n    return a - b\n\n\ndef ok(x):\n    return x == 3\n\n\ndef inside(x):\n    return x > 0 and x < 10\n"


def test_mutants_change_one_line_and_skip_comments_and_strings():
    ms = P.mutants("# a == b\nx = 'a == b'\nreturn a + b\n")
    assert [(m[0], m[1], m[2]) for m in ms] == [(3, "+", "-")] and "a - b" in ms[0][3]
    assert len(P.mutants("\n".join(f"y{i} = a == b" for i in range(40)), cap=6)) == 6


def test_a_test_with_no_assertion_is_refused():
    assert U.has_assertion("python", "def test_a():\n    assert add(1, 2) == 3\n") and not U.has_assertion("python", "def test_a():\n    add(1, 2)\n")
    assert U.has_assertion("rust", "assert_eq!(a, 1);") and not U.has_assertion("typescript", "it('x', () => { a(); });")


@pytest.mark.skipif(not os.path.exists("/usr/bin/env"), reason="needs a shell")
def test_strong_tests_catch_the_changes_and_weak_tests_do_not(tmp_path):
    (tmp_path / "calc.py").write_text(CODE)
    (tmp_path / "tests").mkdir()
    run = lambda lang: T.run_tests(lang, "unit", str(tmp_path))  # noqa: E731
    (tmp_path / "tests" / "test_calc.py").write_text("import sys, pathlib\nsys.path.insert(0, str(pathlib.Path(__file__).parents[1]))\nfrom calc import add, sub, ok, inside\n\n\ndef test_math():\n    assert add(1, 2) == 3\n    assert sub(5, 2) == 3\n\n\ndef test_checks():\n    assert ok(3) is True\n    assert ok(5) is False\n    assert inside(5) is True\n    assert inside(50) is False\n")
    strong = P.prove(str(tmp_path), [("calc.py", "python")], run, minimum=0.5)
    assert strong["enough"] and strong["strength"] == 1.0 and not strong["weak"] and (tmp_path / "calc.py").read_text() == CODE
    (tmp_path / "tests" / "test_calc.py").write_text("import sys, pathlib\nsys.path.insert(0, str(pathlib.Path(__file__).parents[1]))\nfrom calc import add, sub, ok, inside\n\n\ndef test_runs():\n    add(1, 2)\n    sub(5, 2)\n    ok(3)\n    inside(5)\n    assert True\n")
    weak = P.prove(str(tmp_path), [("calc.py", "python")], run, minimum=0.5)
    assert weak["weak"] and weak["strength"] == 0.0 and weak["survived"] and (tmp_path / "calc.py").read_text() == CODE
