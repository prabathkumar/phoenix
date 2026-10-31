import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from phoenix_api import analytics, db  # noqa: E402


@pytest.fixture(autouse=True)
def fresh(tmp_path, monkeypatch):
    url = f"sqlite:///{tmp_path}/t.db"
    monkeypatch.setenv("DATABASE_URL", url)
    monkeypatch.delenv("CLICKHOUSE_URL", raising=False)
    db._engines.clear()
    analytics.reset(analytics.Analytics(env={}))
    yield url
    db._engines.clear()
