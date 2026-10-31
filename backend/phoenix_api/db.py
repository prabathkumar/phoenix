"""PostgreSQL is the system of record (SQLAlchemy 2). DATABASE_URL=postgresql+psycopg://user:pass@host:5432/phoenix
Without DATABASE_URL a local SQLite file is used so a laptop or a test run still works; production is Postgres.
Documents (prompts, MCP servers, guardrail rules, run records) live in `docs` as JSON; things people query and sign
(test cases, sign-offs and their audit trail, executions) are real tables."""
import os
import threading
from datetime import datetime, timezone

from sqlalchemy import JSON, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint, create_engine, event
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker
from sqlalchemy.pool import StaticPool

Json = JSON().with_variant(JSONB(), "postgresql")


def now():
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class Doc(Base):
    __tablename__ = "docs"
    __table_args__ = (UniqueConstraint("kind", "key"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    kind: Mapped[str] = mapped_column(String(32), index=True)
    key: Mapped[str] = mapped_column(String(160))
    doc: Mapped[dict] = mapped_column(Json)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, onupdate=now)


class TestCase(Base):
    __tablename__ = "test_cases"
    __test__ = False
    id: Mapped[str] = mapped_column(String(64), primary_key=True)          # e.g. TST-TC-5097
    project: Mapped[str] = mapped_column(String(64), default="", index=True)
    requirement: Mapped[str] = mapped_column(String(64), default="", index=True)
    title: Mapped[str] = mapped_column(String(300))
    steps: Mapped[list] = mapped_column(Json, default=list)
    priority: Mapped[str] = mapped_column(String(16), default="Medium")
    who: Mapped[str] = mapped_column(String(16), default="ai")              # ai | human
    signoff: Mapped[str] = mapped_column(String(24), default="draft", index=True)  # draft|pending|approved|rejected|changes-requested
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class Execution(Base):
    __tablename__ = "executions"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    run_id: Mapped[str] = mapped_column(String(40), index=True)
    case_id: Mapped[str] = mapped_column(String(64), index=True)
    result: Mapped[str] = mapped_column(String(16))                         # passed|failed|blocked|skipped
    who: Mapped[str] = mapped_column(String(16), default="ai")
    where: Mapped[str] = mapped_column(String(120), default="")
    detail: Mapped[str] = mapped_column(Text, default="")
    ms: Mapped[int] = mapped_column(Integer, default=0)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, index=True)


class Signoff(Base):
    """A decision on one subject: a test case ('case') or a whole run/release ('run')."""
    __tablename__ = "signoffs"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    kind: Mapped[str] = mapped_column(String(8), index=True)                # case | run
    subject: Mapped[str] = mapped_column(String(64), index=True)
    status: Mapped[str] = mapped_column(String(24), default="pending")      # pending|approved|rejected|changes-requested
    requested_by: Mapped[str] = mapped_column(String(120), default="")
    decided_by: Mapped[str] = mapped_column(String(120), default="")
    note: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class SignoffEvent(Base):
    """Append-only audit trail: who did what, when. Never edited or deleted."""
    __tablename__ = "signoff_events"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    signoff_id: Mapped[int] = mapped_column(ForeignKey("signoffs.id"), index=True)
    action: Mapped[str] = mapped_column(String(24))
    actor: Mapped[str] = mapped_column(String(120))
    note: Mapped[str] = mapped_column(Text, default="")
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


_engines = {}
_lock = threading.Lock()


def engine_for(url=None):
    url = url or os.environ.get("DATABASE_URL") or "sqlite:///phoenix.db"
    if url.startswith("postgres://"):
        url = "postgresql+psycopg://" + url[len("postgres://"):]
    elif url.startswith("postgresql://"):
        url = "postgresql+psycopg://" + url[len("postgresql://"):]
    with _lock:  # the first requests can arrive together; tables are created once
        return _engine_locked(url)


def _engine_locked(url):
    if url not in _engines:
        kw = {}
        if url.startswith("sqlite"):
            kw = {"connect_args": {"check_same_thread": False}}
            if ":memory:" in url:
                kw["poolclass"] = StaticPool
        e = create_engine(url, future=True, pool_pre_ping=True, **kw)
        try:
            Base.metadata.create_all(e)
        except Exception:  # another worker created them at the same moment (Postgres); check again, then fail loudly if still broken
            Base.metadata.create_all(e)
        _engines[url] = e
    return _engines[url]


def session(url=None) -> Session:
    return sessionmaker(engine_for(url), expire_on_commit=False)()


def dialect(url=None):
    return engine_for(url).dialect.name


# ---- documents
def doc_get(kind, key, url=None):
    with session(url) as s:
        r = s.query(Doc).filter_by(kind=kind, key=key).one_or_none()
        return r.doc if r else None


def doc_put(kind, key, doc, url=None):
    with session(url) as s:
        r = s.query(Doc).filter_by(kind=kind, key=key).one_or_none()
        if r:
            r.doc = doc
        else:
            s.add(Doc(kind=kind, key=key, doc=doc))
        s.commit()
    return doc


def doc_list(kind, url=None):
    with session(url) as s:
        return [r.doc for r in s.query(Doc).filter_by(kind=kind).order_by(Doc.key).all()]


def doc_delete(kind, key, url=None):
    with session(url) as s:
        s.query(Doc).filter_by(kind=kind, key=key).delete()
        s.commit()
