import importlib.util
import io
import json
import os
import sys
import zipfile

import pytest

spec = importlib.util.spec_from_file_location("teams_build", os.path.join(os.path.dirname(__file__), "..", "..", "teams-app", "build.py"))
B = importlib.util.module_from_spec(spec)
spec.loader.exec_module(B)
ID = "11111111-2222-4333-8444-555555555555"


def test_package_is_complete_and_valid(tmp_path):
    out = B.build(ID.upper(), "https://phoenix.example.com/", str(tmp_path / "t.zip"))
    z = zipfile.ZipFile(out)
    assert sorted(z.namelist()) == ["color.png", "manifest.json", "outline.png"]
    m = json.loads(z.read("manifest.json"))
    assert m["id"] == ID and m["webApplicationInfo"] == {"id": ID, "resource": f"api://phoenix.example.com/{ID}"} and m["validDomains"] == ["phoenix.example.com"]
    assert m["activities"]["activityTypes"][0]["type"] == "phoenixAlert" and B.check(m) == []
    from PIL import Image
    assert Image.open(io.BytesIO(z.read("color.png"))).size == (192, 192) and Image.open(io.BytesIO(z.read("outline.png"))).size == (32, 32)
    assert "secret" not in z.read("manifest.json").decode().lower()


def test_bad_inputs_are_refused_not_built(tmp_path):
    for app_id, url in (("not-a-guid", "https://x.example.com"), (ID, "http://x.example.com"), (None, "https://x.example.com"), (ID, "")):
        with pytest.raises(SystemExit):
            B.build(app_id, url, str(tmp_path / "x.zip"))
    assert not (tmp_path / "x.zip").exists()
    m = B.manifest(ID, "https://x.example.com")
    m["activities"]["activityTypes"] = []
    assert "phoenixAlert" in B.check(m)[0]
