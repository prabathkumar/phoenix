"""Proof that AI-written tests can actually fail.

A test that only runs the code proves nothing. So after the tests pass, Phoenix makes small deliberate changes to the code
under test (flips == to !=, and to or, true to false, + to -, and so on), one at a time, and runs the tests again. A change the
tests notice is CAUGHT. A change that no test notices SURVIVED: the tests are too weak to trust. The share caught is the strength.
Language-neutral on purpose (text-level changes), so it works for every language the connectors run. Never touches the original
checkout files for good: each file is put back, always."""
import os
import re

SWAPS = [("==", "!="), ("!=", "=="), (" and ", " or "), (" or ", " and "), ("&&", "||"), ("||", "&&"), ("True", "False"), ("False", "True"),
         ("true", "false"), ("false", "true"), (" + ", " - "), (" - ", " + "), (" >= ", " < "), (" <= ", " > "), (" > ", " <= "), (" < ", " >= ")]
COMMENT = re.compile(r"^\s*(#|//|\*|/\*|--|<!--)")


def mutants(code, cap=6):
    """-> [(line_number, from, to, mutated_code)] spread across the file, at most `cap`."""
    lines, found = code.split("\n"), []
    for i, line in enumerate(lines):
        if COMMENT.match(line) or not line.strip():
            continue
        for a, b in SWAPS:
            at = line.find(a)
            if at >= 0 and not _in_string(line, at):
                found.append((i, a.strip(), b.strip(), line[:at] + b + line[at + len(a):]))
                break  # one change per line is enough
    if len(found) > cap:
        step = len(found) / cap
        found = [found[int(k * step)] for k in range(cap)]
    return [(i + 1, a, b, "\n".join(lines[:i] + [new] + lines[i + 1:])) for i, a, b, new in found]


def _in_string(line, at):
    return (line[:at].count('"') % 2 == 1) or (line[:at].count("'") % 2 == 1)


def prove(root, sources, run_unit, cap=6, minimum=0.5):
    """sources: [(relative path, language)]. run_unit(language) -> {ok, tests, ...} runs that language's unit tests in `root`.
    -> {mutants, caught, survived: [...], strength, enough, weak}. A file is always restored."""
    total, caught, survived = 0, 0, []
    for rel, lang in sources:
        path = os.path.join(root, *rel.split("/"))
        try:
            original = open(path, encoding="utf8").read()
        except OSError:
            continue
        for line, a, b, new in mutants(original, cap):
            total += 1
            try:
                open(path, "w", encoding="utf8").write(new)
                r = run_unit(lang)
            finally:
                open(path, "w", encoding="utf8").write(original)
            if r.get("tests") and r.get("ok"):
                survived.append({"file": rel, "line": line, "change": f"{a} -> {b}"})
            else:
                caught += 1  # a failing test, or code that no longer builds: the change was noticed
            if total >= cap * 3:
                break
    strength = round(caught / total, 2) if total else None
    enough = total >= 3
    return {"mutants": total, "caught": caught, "survived": survived[:20], "strength": strength, "enough": enough, "weak": bool(enough and strength is not None and strength < minimum)}
