"""Laptop runners: TestOps in AWS uses a browser on a person's own computer (on the VPN or intranet) without any inbound network opening.
The laptop runner (runner/phoenix-runner.js) connects OUT to this hub over a WebSocket. Phoenix then sends it jobs: run a test case, or open a live browser the tester sees and types into.
- Pairing: a signed-in person asks for a one-time code (10 minutes), types it on the laptop, and gets a runner token. Only a hash of the token is kept; revoke any time.
- Allowlist: the pairing says which hosts the runner may open (exact, *.domain, IPv4 range). Default deny; cloud-metadata ranges are always refused. Checked here AND on the laptop.
- Jobs belong to the person who paired the runner. A live view is watched through a one-time ticket, relayed through this hub, so the laptop never listens on the network.
Keeping a typed password out of steps and logs is done in the live view (secret flag); the hub relays frames and keystrokes and does not store them."""
import asyncio
import hashlib
import ipaddress
import json
import os
import re
import secrets
import time
from urllib.parse import urlparse

from fastapi import Body, Header, HTTPException, WebSocket, WebSocketDisconnect

CODE_TTL, TICKET_TTL, MAX_RESULT = 600, 60, 1_000_000
DENY = [ipaddress.ip_network("169.254.0.0/16"), ipaddress.ip_network("0.0.0.0/8")]


def bad_pattern(p):
    p = str(p or "").strip().lower()
    if not p or len(p) > 120:
        return "empty or too long"
    if "/" in p:
        ip, _, bits = p.partition("/")
        try:
            ipaddress.IPv4Address(ip)
        except ValueError:
            return "a range must be IPv4 with /8 to /32"
        return None if bits.isdigit() and 8 <= int(bits) <= 32 else "a range must be IPv4 with /8 to /32"
    if p.startswith("*."):
        rest = p[2:]
        return None if re.fullmatch(r"[a-z0-9-]+(\.[a-z0-9-]+)+", rest) else "wildcard needs a domain such as *.corp.example.com"
    return None if re.fullmatch(r"[a-z0-9-]+(\.[a-z0-9-]+)*", p) else "not a host name or address"


def allowed(url, patterns):
    try:
        u = urlparse(str(url))
        host = (u.hostname or "").lower()
    except ValueError:
        return False
    if u.scheme not in ("http", "https") or not host or u.username or u.password:
        return False
    ip = None
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        pass
    if ip is not None and (any(ip in n for n in DENY if ip.version == 4) if ip.version == 4 else host.startswith(("fe80", "fd00:ec2"))):
        return False
    for raw in patterns or []:
        p = str(raw).strip().lower()
        if bad_pattern(p):
            continue
        if "/" in p:
            if ip is not None and ip.version == 4 and ip in ipaddress.ip_network(p, strict=False):
                return True
        elif p.startswith("*."):
            if host.endswith(p[1:]) and len(host) > len(p) - 1:
                return True
        elif host == p:
            return True
    return False


def _h(s):
    return hashlib.sha256(s.encode()).hexdigest()


class Hub:
    def __init__(self, env):
        self.env = env
        self.path = os.path.join(env.get("PHOENIX_DATA_DIR", "."), "runners.json")
        self.codes, self.conns, self.jobs, self.tickets = {}, {}, {}, {}
        self.runners = self._load()

    def _load(self):
        try:
            return json.load(open(self.path))
        except Exception:
            return {}

    def _save(self):
        os.makedirs(os.path.dirname(os.path.abspath(self.path)), exist_ok=True)
        tmp = self.path + ".tmp"
        json.dump(self.runners, open(tmp, "w"), indent=1)
        os.chmod(tmp, 0o600)
        os.replace(tmp, self.path)

    def is_admin(self, who):
        return str(who).strip().lower() in [a.strip().lower() for a in self.env.get("PHOENIX_ADMINS", "").split(",") if a.strip()]

    # ---- pairing
    def pair(self, user, name, allow):
        allow = [str(a).strip().lower() for a in (allow or []) if str(a).strip()]
        if not allow:
            raise ValueError("list at least one address the runner may open, such as *.corp.example.com")
        for a in allow[:20]:
            e = bad_pattern(a)
            if e:
                raise ValueError(f"'{a}': {e}")
        code = "-".join(secrets.token_hex(2).upper() for _ in range(2))
        self.codes = {k: v for k, v in self.codes.items() if v["exp"] > time.time()}
        self.codes[_h(code)] = {"user": user, "name": str(name or "my laptop")[:60], "allow": allow[:20], "exp": time.time() + CODE_TTL}
        return {"code": code, "expiresIn": CODE_TTL, "allow": allow[:20]}

    def register(self, code, name, os_name):
        c = self.codes.pop(_h(str(code or "").strip().upper()), None)           # single use
        if not c or c["exp"] < time.time():
            raise ValueError("that code is wrong or has expired: get a new one in Phoenix > Runners")
        rid, token = "rn_" + secrets.token_hex(5), secrets.token_urlsafe(32)
        self.runners[rid] = {"user": c["user"], "name": str(name or c["name"])[:60], "os": str(os_name or "")[:60], "allow": c["allow"], "tokenHash": _h(token), "createdAt": int(time.time()), "lastSeen": 0}
        self._save()
        return {"runnerId": rid, "token": token, "allow": c["allow"]}

    def authenticate(self, token):
        th = _h(str(token or ""))
        for rid, r in self.runners.items():
            if secrets.compare_digest(r["tokenHash"], th):
                return rid
        return None

    def listing(self, user):
        return [{"id": i, "name": r["name"], "os": r["os"], "allow": r["allow"], "online": i in self.conns, "lastSeen": r["lastSeen"], "createdAt": r["createdAt"]} for i, r in self.runners.items() if r["user"] == user]

    async def revoke(self, user, rid):
        r = self.runners.get(rid)
        if not r or (r["user"] != user and not self.is_admin(user)):
            return False
        ws = self.conns.pop(rid, None)
        del self.runners[rid]
        self._save()
        if ws:
            try:
                await ws.send_text(json.dumps({"type": "revoked"}))
                await ws.close()
            except Exception:  # noqa: BLE001
                pass
        return True

    # ---- jobs
    async def create_job(self, user, rid, spec):
        r = self.runners.get(rid)
        if not r or r["user"] != user:
            raise PermissionError("that runner is not yours")
        ws = self.conns.get(rid)
        if not ws:
            raise LookupError("that runner is offline: start it on the laptop (node runner/phoenix-runner.js start)")
        if any(j["runner"] == rid and j["status"] == "running" for j in self.jobs.values()):
            raise LookupError("that runner is already busy")
        kind = spec.get("kind")
        if kind == "live":
            urls = [spec.get("url")]
        elif kind == "web-case":
            steps = spec.get("steps")
            if not isinstance(steps, list) or not steps or len(json.dumps(steps)) > 400_000:
                raise ValueError("steps must be a non-empty list of recorded web steps")
            urls = [spec.get("baseUrl")] if spec.get("baseUrl") else []
            for s in steps:
                urls += re.findall(r"https?://[^\s\"')]+", str((s or {}).get("url") or (s or {}).get("value") or (s or {}).get("instruction") or "")) if isinstance(s, dict) else []
        else:
            raise ValueError("kind must be live or web-case")
        for u in urls:
            if not allowed(u, r["allow"]):
                raise ValueError(f"{urlparse(str(u)).hostname or u} is not in this runner's allowed list")
        if kind == "live" and not spec.get("url"):
            raise ValueError("give the address to open")
        jid = "job_" + secrets.token_hex(5)
        job = {"id": jid, "runner": rid, "user": user, "kind": kind, "status": "running", "result": None, "at": int(time.time()), "viewer": None}
        self.jobs[jid] = job
        msg = {"type": "job", "id": jid, "kind": kind, "name": str(spec.get("name") or "")[:80]}
        msg.update({"url": spec["url"]} if kind == "live" else {"steps": spec["steps"], "baseUrl": spec.get("baseUrl"), "testData": spec.get("testData"), "headed": spec.get("headed", True)})
        await ws.send_text(json.dumps(msg))
        out = {"jobId": jid}
        if kind == "live":
            t = secrets.token_urlsafe(16)
            self.tickets[t] = (jid, time.time() + TICKET_TTL)
            out["viewTicket"] = t
        return out

    def new_ticket(self, user, jid):
        j = self.jobs.get(jid)
        if not j or j["user"] != user or j["kind"] != "live":
            raise PermissionError("not your live session")
        t = secrets.token_urlsafe(16)
        self.tickets[t] = (jid, time.time() + TICKET_TTL)
        return t

    def job_view(self, user, jid):
        j = self.jobs.get(jid)
        if not j or j["user"] != user:
            return None
        return {k: v for k, v in j.items() if k != "viewer"}

    # ---- sockets
    async def runner_socket(self, ws: WebSocket):
        auth = ws.headers.get("authorization", "")
        rid = self.authenticate(auth[7:] if auth.lower().startswith("bearer ") else "")
        if not rid:
            await ws.close(code=4401)
            return
        await ws.accept()
        old = self.conns.get(rid)
        self.conns[rid] = ws
        if old:
            try:
                await old.close()
            except Exception:  # noqa: BLE001
                pass
        try:
            while True:
                try:
                    m = json.loads(await ws.receive_text())
                except ValueError:
                    continue
                if rid in self.runners:
                    self.runners[rid]["lastSeen"] = int(time.time())
                t, jid = m.get("type"), m.get("id")
                j = self.jobs.get(jid) if jid else None
                if j and j["runner"] != rid:
                    continue                                  # a runner may only speak for its own jobs
                if t == "job-result" and j:
                    res = m.get("result")
                    j["result"] = res if len(json.dumps(res or {})) <= MAX_RESULT else {"success": False, "detail": "result too large"}
                    j["status"] = "done" if (res or {}).get("success") else "failed"
                elif t == "live-out" and j and j.get("viewer"):
                    try:
                        await j["viewer"].send_text(str(m.get("data", ""))[:2_000_000])
                    except Exception:  # noqa: BLE001
                        j["viewer"] = None
                elif t == "live-closed" and j:
                    j["status"], j["result"] = "done", {"success": True, "detail": m.get("reason", "session ended")}
                    if j.get("viewer"):
                        try:
                            await j["viewer"].send_text(json.dumps({"type": "runner-closed", "message": m.get("reason", "session ended")}))
                            await j["viewer"].close()
                        except Exception:  # noqa: BLE001
                            pass
        except WebSocketDisconnect:
            pass
        finally:
            if self.conns.get(rid) is ws:
                del self.conns[rid]
            for j in self.jobs.values():
                if j["runner"] == rid and j["status"] == "running":
                    j["status"], j["result"] = "failed", {"success": False, "detail": "the runner disconnected"}

    async def view_socket(self, ws: WebSocket, jid: str, ticket: str):
        got = self.tickets.pop(ticket, None)                  # single use
        j = self.jobs.get(jid)
        if not got or got[0] != jid or got[1] < time.time() or not j or j["status"] != "running":
            await ws.close(code=4403)
            return
        await ws.accept()
        j["viewer"] = ws
        rws = self.conns.get(j["runner"])
        try:
            while True:
                data = await ws.receive_text()
                if rws and len(data) < 100_000:
                    await rws.send_text(json.dumps({"type": "live-in", "id": jid, "data": data}))
        except WebSocketDisconnect:
            pass
        finally:
            j["viewer"] = None
            if rws and j["status"] == "running":
                try:
                    await rws.send_text(json.dumps({"type": "live-stop", "id": jid}))
                except Exception:  # noqa: BLE001
                    pass


def mount(app, D, record):
    hub = Hub(D.env)
    app.state.runner_hub = hub

    def need(x_user):
        if not x_user.strip() or "@" not in x_user:
            raise HTTPException(401, "Say who you are (X-User, your work address).")
        return x_user.strip()

    @app.post("/api/runners/pair")
    def runners_pair(body: dict = Body(default={}), x_user: str = Header(default="")):
        """A one-time code to type on the laptop, and the addresses the runner may open."""
        u = need(x_user)
        try:
            r = hub.pair(u, body.get("name"), body.get("allow"))
        except ValueError as e:
            raise HTTPException(400, str(e))
        record("runner-pair", u, ",".join(r["allow"]))
        return r

    @app.post("/api/runners/register")
    def runners_register(body: dict = Body(default={})):
        """Called by the laptop runner with the code. Returns its token once."""
        try:
            return hub.register(body.get("code"), body.get("name"), body.get("os"))
        except ValueError as e:
            raise HTTPException(400, str(e))

    @app.get("/api/runners")
    def runners_list(x_user: str = Header(default="")):
        return {"runners": hub.listing(need(x_user))}

    @app.delete("/api/runners/{rid}")
    async def runners_revoke(rid: str, x_user: str = Header(default="")):
        u = need(x_user)
        if not await hub.revoke(u, rid):
            raise HTTPException(404, "no such runner of yours")
        record("runner-revoke", u, rid)
        return {"ok": True}

    @app.post("/api/runners/{rid}/jobs")
    async def runners_job(rid: str, body: dict = Body(...), x_user: str = Header(default="")):
        """{kind: "live", url} or {kind: "web-case", steps, baseUrl?, testData?}. Only on your own runner, only at its allowed addresses."""
        u = need(x_user)
        try:
            r = await hub.create_job(u, rid, body)
        except PermissionError as e:
            raise HTTPException(403, str(e))
        except LookupError as e:
            raise HTTPException(409, str(e))
        except ValueError as e:
            raise HTTPException(400, str(e))
        record(f"runner-{body.get('kind')}", u, rid)
        return r

    @app.get("/api/runners/jobs/{jid}")
    def runners_job_get(jid: str, x_user: str = Header(default="")):
        j = hub.job_view(need(x_user), jid)
        if not j:
            raise HTTPException(404, "no such job of yours")
        return j

    @app.post("/api/runners/jobs/{jid}/ticket")
    def runners_ticket(jid: str, x_user: str = Header(default="")):
        try:
            return {"viewTicket": hub.new_ticket(need(x_user), jid)}
        except PermissionError as e:
            raise HTTPException(403, str(e))

    @app.websocket("/api/runners/connect")
    async def runners_connect(ws: WebSocket):
        await hub.runner_socket(ws)

    @app.websocket("/api/runners/jobs/{jid}/view")
    async def runners_view(ws: WebSocket, jid: str, ticket: str = ""):
        await hub.view_socket(ws, jid, ticket)
    return hub
