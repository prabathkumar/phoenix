"""Runs the sign-off flow against a real PostgreSQL when PHOENIX_TEST_POSTGRES is set (CI does; a laptop skips it)."""
import os

import pytest

from phoenix_api import db, signoff

URL = os.environ.get("PHOENIX_TEST_POSTGRES")
pytestmark = pytest.mark.skipif(not URL, reason="PHOENIX_TEST_POSTGRES is not set")


def test_signoff_flow_and_documents_on_postgres(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", URL)
    db._engines.clear()
    eng = db.engine_for(URL)
    assert eng.dialect.name == "postgresql"
    db.Base.metadata.drop_all(eng)
    db.Base.metadata.create_all(eng)
    db.doc_put("prompt", "x.shared", {"name": "x", "versions": []})
    assert db.doc_get("prompt", "x.shared")["name"] == "x"
    signoff.upsert_case("TC-1", "Login", ["a"], requirement="R")
    so = signoff.request_case("TC-1", "alice")
    with pytest.raises(signoff.SignoffError):
        signoff.decide(so["id"], "approved", "alice")
    assert signoff.decide(so["id"], "approved", "bob")["status"] == "approved"
    signoff.record_execution("run-1", "TC-1", "passed")
    assert signoff.funnel()["cases"]["approved"] == 1
