import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from phoenix_api import analytics, db  # noqa: E402


@pytest.fixture(autouse=True)
def fresh(tmp_path, monkeypatch):
    import os
    url = os.environ.get("PHOENIX_TEST_POSTGRES_ALL") or f"sqlite:///{tmp_path}/t.db"  # set it to run the whole suite on PostgreSQL
    monkeypatch.setenv("DATABASE_URL", url)
    monkeypatch.delenv("CLICKHOUSE_URL", raising=False)
    db._engines.clear()
    if url.startswith("postgres"):
        e = db.engine_for(url)
        db.Base.metadata.drop_all(e)
        db.Base.metadata.create_all(e)
    analytics.reset(analytics.Analytics(env={}))
    yield url
    db._engines.clear()
