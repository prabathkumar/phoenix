"""Product plugins: one specialised agent per business product (SuiteCRM, OTOBO, OTRS, SAP, Salesforce, Microsoft Dynamics 365).
The agent does not guess the product's API. It calls the plugin, which knows the product's objects, sign-in, calls and sample data, and the plugin does the job:
  plan      -> product test cases (valid, boundary, invalid, hostile data) built from the plugin's schemas, plus product scenarios
  functional-> those cases fired at the product through the same engine as the API tests (writes only with allowWrites)
  readback  -> create a tagged record, read it back, compare, remove it where the product allows
  security  -> unauthenticated and bad-token calls refused, no stack traces or SQL in errors, https only
  perf      -> read-only calls and a Locust file that takes its token from the environment
Credentials come from the server's environment (<PREFIX>_*), never from a request. Nothing here has been run against a real SAP, Salesforce, Dynamics, SuiteCRM, OTOBO or OTRS system:
the call shapes follow each vendor's documented API from memory and must be confirmed with a sandbox (see docs/PRODUCT_PLUGINS.md)."""
import json
import re
import time
from urllib.parse import urlencode, urlparse

from . import api_functional as AF, api_layer

TAG = "PHOENIX-TEST"
LEAK = re.compile(r"Traceback \(most recent|at (com|org|java)\.[\w.]+\(|ORA-\d{4,5}|SQLSTATE|SQL syntax|stack trace|System\.\w+Exception|ABAP runtime error|Exception in thread", re.I)
TOKEN_HOSTS = {"salesforce": r"(^|\.)salesforce\.com$|(^|\.)force\.com$", "dynamics365": r"^login\.microsoftonline\.com$"}


def _ver(v):
    return tuple(int(x) for x in re.findall(r"\d+", str(v))[:3])


def compat(p, product_version):
    """ok | newer | older | unknown. 'newer' = the product has moved past what this plugin was written for: upgrade the plugin."""
    if not p.supports or not product_version:
        return "unknown"
    v = _ver(product_version)
    lo, hi = _ver(p.supports[0]), _ver(p.supports[1])
    return "older" if v[:len(lo)] < lo else "newer" if v[:len(hi)] > hi else "ok"


def _obj(props, required=(), **extra):
    return {"type": "object", "properties": props, "required": list(required), **extra}


S = {"type": "string"}
STR = lambda mx=None, **k: {"type": "string", **({"maxLength": mx} if mx else {}), **k}


class Plugin:
    id = name = vendor = family = prefix = ""
    needs = ()
    version = "0.1.0"                      # THIS plugin's own version: released and upgraded on its own when the product changes
    supports = None                        # (lowest, highest) product version the plugin was written for, e.g. ("19.0", "19.0"); None = not declared
    read_only = False                      # True: no write call is ever built or run
    scenarios_text = ()

    def base(self, cfg):
        return cfg[f"{self.prefix}_BASE_URL"].rstrip("/")

    async def product_version(self, cfg, fetch, auth):
        """The running product's version, or None when the product does not say."""
        return None

    async def login(self, cfg, fetch):     # -> {"headers": {}, "query": {}}
        return {"headers": {}, "query": {}}

    def entities(self):                    # [{name, list, item, create, schema, id_in, delete}]
        return []

    def endpoints(self, cfg):
        out = []
        for e in self.entities():
            out.append({"method": "GET", "path": e["list"], "pathParams": [], "query": [], "responses": {"200": e.get("list_schema")}, "summary": f"list {e['name']}"})
            out.append({"method": "GET", "path": e["item"], "pathParams": ["id"], "query": [], "responses": {"200": e.get("item_schema")}, "summary": f"read one {e['name']}"})
            if not self.read_only and e.get("schema"):
                out.append({"method": "POST", "path": e["list"], "pathParams": [], "query": [], "requestSchema": e["schema"], "responses": {"201": None}, "summary": f"create {e['name']}"})
        return [api_layer.enrich(x) for x in out]


class Salesforce(Plugin):
    id, name, vendor, family, prefix = "salesforce", "Salesforce", "Salesforce", "crm", "SALESFORCE"
    needs = ("SALESFORCE_BASE_URL", "SALESFORCE_CLIENT_ID", "SALESFORCE_CLIENT_SECRET")
    scenarios_text = ("Lead to opportunity: create a lead, convert it, move the opportunity through the stages to Closed Won",
                      "Account and contacts: create an account with two contacts, edit the billing address, confirm both contacts follow",
                      "Case handling: log a case against a contact, assign, escalate, close, confirm the status history",
                      "Validation and duplicate rules: a missing required field and a duplicate account are rejected with a readable message")

    version, supports = "0.1.0", ("60.0", "65.0")      # Salesforce API versions; the range is a declared guess until checked against a sandbox

    async def product_version(self, cfg, fetch, auth):
        st, tx = await fetch("GET", self.base(cfg) + "/services/data/", auth["headers"], None)
        try:
            return max((x["version"] for x in json.loads(tx)), key=_ver) if st == 200 else None
        except Exception:
            return None

    async def login(self, cfg, fetch):
        url = cfg.get("SALESFORCE_TOKEN_URL") or self.base(cfg) + "/services/oauth2/token"
        body = urlencode({"grant_type": "client_credentials", "client_id": cfg["SALESFORCE_CLIENT_ID"], "client_secret": cfg["SALESFORCE_CLIENT_SECRET"]})
        st, tx = await fetch("POST", url, {"Content-Type": "application/x-www-form-urlencoded"}, body)
        if st != 200:
            raise RuntimeError(f"Salesforce sign-in refused ({st})")
        return {"headers": {"Authorization": "Bearer " + json.loads(tx)["access_token"]}, "query": {}}

    def entities(self):
        return [{"name": n, "list": f"/services/data/v62.0/sobjects/{n}/describe", "item": f"/services/data/v62.0/sobjects/{n}/{{id}}", "id_in": "id",
                 "create": f"/services/data/v62.0/sobjects/{n}", "delete": True, "schema": sch}
                for n, sch in (("Account", _obj({"Name": STR(255), "Industry": STR(40), "Phone": STR(40)}, ["Name"])),
                               ("Contact", _obj({"LastName": STR(80), "FirstName": STR(40), "Email": STR(80, format="email")}, ["LastName"])),
                               ("Lead", _obj({"LastName": STR(80), "Company": STR(255)}, ["LastName", "Company"])),
                               ("Case", _obj({"Subject": STR(255), "Origin": STR(40)}, [])))]

    def endpoints(self, cfg):
        out = []
        for e in self.entities():
            out.append({"method": "GET", "path": e["list"], "pathParams": [], "query": [], "responses": {"200": None}, "summary": f"describe {e['name']}"})
            out.append({"method": "GET", "path": e["item"], "pathParams": ["id"], "query": [], "responses": {"200": None}, "summary": f"read one {e['name']}"})
            out.append({"method": "POST", "path": e["create"], "pathParams": [], "query": [], "requestSchema": e["schema"], "responses": {"201": None}, "summary": f"create {e['name']}"})
        return [api_layer.enrich(x) for x in out]


class Dynamics365(Plugin):
    id, name, vendor, family, prefix = "dynamics365", "Microsoft Dynamics 365", "Microsoft", "crm-erp", "D365"
    needs = ("D365_BASE_URL", "D365_TENANT_ID", "D365_CLIENT_ID", "D365_CLIENT_SECRET")
    version, supports = "0.1.0", ("9.2", "9.2")

    async def product_version(self, cfg, fetch, auth):
        st, tx = await fetch("GET", self.base(cfg) + "/RetrieveVersion()", auth["headers"], None)
        try:
            return json.loads(tx).get("Version") if st == 200 else None
        except Exception:
            return None
    scenarios_text = ("Lead to opportunity to quote: qualify a lead, create the opportunity, add products, produce a quote",
                      "Account and contacts: create an account with a primary contact, change the owner, confirm access follows",
                      "Case management: create a case, route by queue, resolve, confirm SLA fields are set",
                      "Duplicate detection and required fields: rejected with the platform's message and a 4xx")

    async def login(self, cfg, fetch):
        url = f"https://login.microsoftonline.com/{cfg['D365_TENANT_ID']}/oauth2/v2.0/token"
        body = urlencode({"grant_type": "client_credentials", "client_id": cfg["D365_CLIENT_ID"], "client_secret": cfg["D365_CLIENT_SECRET"], "scope": self.base(cfg).split("/api/")[0] + "/.default"})
        st, tx = await fetch("POST", url, {"Content-Type": "application/x-www-form-urlencoded"}, body)
        if st != 200:
            raise RuntimeError(f"Dynamics 365 sign-in refused ({st})")
        return {"headers": {"Authorization": "Bearer " + json.loads(tx)["access_token"], "OData-Version": "4.0", "Prefer": "return=representation"}, "query": {}}

    def entities(self):
        return [{"name": n, "list": f"/{n}?$top=5", "item": f"/{n}({{id}})", "id_in": idk, "create": f"/{n}", "delete": True, "schema": sch}
                for n, idk, sch in (("accounts", "accountid", _obj({"name": STR(160), "telephone1": STR(50)}, ["name"])),
                                    ("contacts", "contactid", _obj({"lastname": STR(50), "firstname": STR(50), "emailaddress1": STR(100, format="email")}, ["lastname"])),
                                    ("leads", "leadid", _obj({"lastname": STR(50), "subject": STR(300)}, ["lastname"])),
                                    ("incidents", "incidentid", _obj({"title": STR(200)}, ["title"])))]

    def endpoints(self, cfg):
        out = []
        for e in self.entities():
            out.append({"method": "GET", "path": e["list"], "pathParams": [], "query": [], "responses": {"200": None}, "summary": f"list {e['name']}"})
            out.append({"method": "GET", "path": e["item"], "pathParams": ["id"], "query": [], "responses": {"200": None}, "summary": f"read one {e['name']}"})
            out.append({"method": "POST", "path": e["create"], "pathParams": [], "query": [], "requestSchema": e["schema"], "responses": {"201": None}, "summary": f"create {e['name']}"})
        return [api_layer.enrich(x) for x in out]


class SAP(Plugin):
    id, name, vendor, family, prefix = "sap", "SAP S/4HANA (OData)", "SAP", "erp", "SAP"
    needs = ("SAP_BASE_URL",)
    read_only = True      # SAP writes need an X-CSRF-Token fetched from a response header; the shared HTTP seam returns no headers yet, so only reads and rejected-input checks run
    scenarios_text = ("Order to cash: create a sales order for a business partner, deliver, bill, confirm the document flow and the posted invoice",
                      "Procure to pay: purchase requisition, purchase order, goods receipt, invoice receipt, three-way match",
                      "Business partner master data: create and change a customer, check the role and address",
                      "Authorisation: a user without the role is refused (403) on sales order read and write",
                      "Period and currency: posting into a closed period and an unknown currency are rejected")

    async def login(self, cfg, fetch):
        import base64
        if cfg.get("SAP_TOKEN"):
            return {"headers": {"Authorization": "Bearer " + cfg["SAP_TOKEN"]}, "query": {}}
        if cfg.get("SAP_USER") and cfg.get("SAP_PASSWORD"):
            return {"headers": {"Authorization": "Basic " + base64.b64encode(f"{cfg['SAP_USER']}:{cfg['SAP_PASSWORD']}".encode()).decode()}, "query": {}}
        raise RuntimeError("SAP needs SAP_TOKEN, or SAP_USER and SAP_PASSWORD (a technical test user)")

    def entities(self):
        return [{"name": "A_BusinessPartner", "list": "/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_BusinessPartner?$top=5&$format=json", "item": "/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_BusinessPartner('{id}')?$format=json", "id_in": "BusinessPartner", "schema": None},
                {"name": "A_SalesOrder", "list": "/sap/opu/odata/sap/API_SALES_ORDER_SRV/A_SalesOrder?$top=5&$format=json", "item": "/sap/opu/odata/sap/API_SALES_ORDER_SRV/A_SalesOrder('{id}')?$format=json", "id_in": "SalesOrder", "schema": None},
                {"name": "A_PurchaseOrder", "list": "/sap/opu/odata/sap/API_PURCHASEORDER_PROCESS_SRV/A_PurchaseOrder?$top=5&$format=json", "item": "/sap/opu/odata/sap/API_PURCHASEORDER_PROCESS_SRV/A_PurchaseOrder('{id}')?$format=json", "id_in": "PurchaseOrder", "schema": None}]


class SuiteCRM(Plugin):
    id, name, vendor, family, prefix = "suitecrm", "SuiteCRM 8", "SalesAgility", "crm", "SUITECRM"
    needs = ("SUITECRM_BASE_URL", "SUITECRM_CLIENT_ID", "SUITECRM_CLIENT_SECRET")
    scenarios_text = ("Lead to opportunity: create a lead, convert it, add the opportunity, move it to Closed Won",
                      "Account with contacts: create, link, edit, confirm the relationship", "Case: log, assign, close, confirm history",
                      "Required field and bad email are rejected with a 4xx")

    async def login(self, cfg, fetch):
        body = urlencode({"grant_type": "client_credentials", "client_id": cfg["SUITECRM_CLIENT_ID"], "client_secret": cfg["SUITECRM_CLIENT_SECRET"]})
        st, tx = await fetch("POST", self.base(cfg) + "/Api/access_token", {"Content-Type": "application/x-www-form-urlencoded"}, body)
        if st != 200:
            raise RuntimeError(f"SuiteCRM sign-in refused ({st})")
        return {"headers": {"Authorization": "Bearer " + json.loads(tx)["access_token"], "Content-Type": "application/vnd.api+json"}, "query": {}}

    def entities(self):
        return [{"name": m, "list": f"/Api/V8/module/{m}?page[size]=5", "item": f"/Api/V8/module/{m}/{{id}}", "id_in": "data.id", "create": f"/Api/V8/module/{m}", "delete": True,
                 "wrap": m, "schema": sch} for m, sch in (("Accounts", _obj({"name": STR(150)}, ["name"])), ("Contacts", _obj({"last_name": STR(100), "first_name": STR(100)}, ["last_name"])),
                                                         ("Leads", _obj({"last_name": STR(100), "status": STR(100)}, ["last_name"])), ("Cases", _obj({"name": STR(255)}, ["name"])))]

    def endpoints(self, cfg):
        out = []
        for e in self.entities():
            out.append({"method": "GET", "path": e["list"], "pathParams": [], "query": [], "responses": {"200": None}, "summary": f"list {e['name']}"})
            out.append({"method": "GET", "path": e["item"], "pathParams": ["id"], "query": [], "responses": {"200": None}, "summary": f"read one {e['name']}"})
            wrapped = _obj({"data": _obj({"type": {"type": "string", "enum": [e["name"]]}, "attributes": e["schema"]}, ["type", "attributes"])}, ["data"])
            out.append({"method": "POST", "path": e["create"], "pathParams": [], "query": [], "requestSchema": wrapped, "responses": {"201": None}, "summary": f"create {e['name']}"})
        return [api_layer.enrich(x) for x in out]


class _Ticketing(Plugin):
    """OTOBO and OTRS share the GenericInterface REST layer. The web service name is set by the administrator (default "GenericTicketConnectorREST")."""
    scenarios_text = ("Ticket lifecycle: create with an article, change queue and priority, add a reply, close, confirm the history",
                      "Customer and queue rules: a customer sees only their own tickets; an agent outside the queue is refused",
                      "SLA and escalation: a ticket past its first-response time shows as escalated",
                      "Required field and bad queue are rejected with an error body and a 4xx")

    def ws(self, cfg):
        return f"/nph-genericinterface.pl/Webservice/{cfg.get(self.prefix + '_WEBSERVICE', 'GenericTicketConnectorREST')}"

    def root(self, cfg):
        return self.base(cfg) + cfg.get(self.prefix + "_PATH", "/otobo")

    async def login(self, cfg, fetch):
        body = json.dumps({"UserLogin": cfg[self.prefix + "_USER"], "Password": cfg[self.prefix + "_PASSWORD"]})
        st, tx = await fetch("POST", self.root(cfg) + self.ws(cfg) + "/Session", {"Content-Type": "application/json"}, body)
        sid = (json.loads(tx) if st == 200 else {}).get("SessionID")
        if not sid:
            raise RuntimeError(f"{self.name} sign-in refused ({st}): check the web service name and the user")
        return {"headers": {}, "query": {"SessionID": sid}}

    def entities(self):
        return [{"name": "Ticket", "list": "/Ticket", "item": "/Ticket/{id}", "id_in": "TicketID", "create": "/Ticket", "delete": False,
                 "schema": _obj({"Ticket": _obj({"Title": STR(255), "Queue": STR(100), "State": STR(50), "Priority": STR(50), "CustomerUser": STR(100)}, ["Title", "Queue"]),
                                 "Article": _obj({"Subject": STR(255), "Body": STR(5000), "ContentType": {"type": "string", "enum": ["text/plain; charset=utf8"]}}, ["Subject", "Body"])}, ["Ticket", "Article"])}]

    def endpoints(self, cfg):
        e = self.entities()[0]
        return [api_layer.enrich(x) for x in (
            {"method": "GET", "path": "/Ticket/{id}", "pathParams": ["id"], "query": [], "responses": {"200": None}, "summary": "read one ticket"},
            {"method": "POST", "path": "/Ticket", "pathParams": [], "query": [], "requestSchema": e["schema"], "responses": {"200": None}, "summary": "create ticket"})]


class OTOBO(_Ticketing):
    id, name, vendor, family, prefix = "otobo", "OTOBO", "Rother OSS", "itsm", "OTOBO"
    needs = ("OTOBO_BASE_URL", "OTOBO_USER", "OTOBO_PASSWORD")


class OTRS(_Ticketing):
    id, name, vendor, family, prefix = "otrs", "OTRS", "OTRS AG", "itsm", "OTRS"
    needs = ("OTRS_BASE_URL", "OTRS_USER", "OTRS_PASSWORD")

    def root(self, cfg):
        return self.base(cfg) + cfg.get("OTRS_PATH", "/otrs")


class Odoo(Plugin):
    """Odoo 19 external JSON-2 API (/json/2/<model>/<method>, bearer API key, X-Odoo-Database). Odoo 17 and 18 use /jsonrpc: that is a different plugin release, which is the point of versioning the plugin."""
    id, name, vendor, family, prefix = "odoo", "Odoo (JSON-2, v19)", "Odoo SA", "erp-crm", "ODOO"
    needs = ("ODOO_BASE_URL", "ODOO_API_KEY", "ODOO_DB")
    version, supports = "0.1.0", ("19.0", "19.0")
    scenarios_text = ("Quotation to invoice: create a quotation for a customer, confirm to a sales order, deliver, invoice, register payment",
                      "CRM: lead to opportunity, move through the stages, mark won",
                      "Purchase: request for quotation, confirm, receive, vendor bill",
                      "Access rights: a user without the sales group is refused (403) on sale.order")
    MODELS = (("res.partner", _obj({"name": STR(255), "email": STR(100, format="email")}, ["name"])),
              ("crm.lead", _obj({"name": STR(255)}, ["name"])), ("sale.order", None))

    async def login(self, cfg, fetch):
        return {"headers": {"Authorization": "bearer " + cfg["ODOO_API_KEY"], "X-Odoo-Database": cfg["ODOO_DB"]}, "query": {}}

    async def product_version(self, cfg, fetch, auth):
        st, tx = await fetch("POST", self.base(cfg) + "/web/webclient/version_info", {"Content-Type": "application/json"}, json.dumps({"jsonrpc": "2.0", "method": "call", "params": {}}))
        try:
            return json.loads(tx)["result"]["server_version"] if st == 200 else None
        except Exception:
            return None

    def endpoints(self, cfg):
        out = []
        for m, sch in self.MODELS:
            out.append({"method": "POST", "path": f"/json/2/{m}/search_read", "pathParams": [], "query": [], "safe": True, "responses": {"200": None}, "summary": f"list {m}",
                        "requestSchema": _obj({"domain": {"type": "array", "items": {"type": "string"}}, "fields": {"type": "array", "items": {"type": "string"}}, "limit": {"type": "integer", "minimum": 1, "maximum": 5}}, [])})
            if sch and not self.read_only:
                out.append({"method": "POST", "path": f"/json/2/{m}/create", "pathParams": [], "query": [], "responses": {"200": None}, "summary": f"create {m}",
                            "requestSchema": _obj({"vals_list": {"type": "array", "items": sch, "minItems": 1, "maxItems": 1}}, ["vals_list"])})
        return [api_layer.enrich(x) for x in out]

    def entities(self):
        return [{"name": m, "schema": sch} for m, sch in self.MODELS]


PLUGINS = {p.id: p for p in (Salesforce(), Dynamics365(), SAP(), SuiteCRM(), OTOBO(), OTRS(), Odoo())}


def catalog(env):
    return [{"id": p.id, "name": p.name, "vendor": p.vendor, "family": p.family, "pluginVersion": p.version, "supports": list(p.supports) if p.supports else None, "readOnly": p.read_only, "needs": list(p.needs), "ready": all(env.get(k) for k in p.needs),
             "missing": [k for k in p.needs if not env.get(k)], "entities": [e["name"] for e in p.entities()], "scenarios": list(p.scenarios_text)} for p in PLUGINS.values()]


def _root(p, cfg):
    return p.root(cfg) + p.ws(cfg) if isinstance(p, _Ticketing) else p.base(cfg)


def _apply(path, auth):
    if not auth.get("query"):
        return path
    return path + ("&" if "?" in path else "?") + urlencode(auth["query"])


def plan(plugin_id, env=None, per_field=2):
    """Cases and scenarios without touching the product."""
    p = PLUGINS[plugin_id]
    eps = p.endpoints(env or {})
    cases = AF.build_cases(eps, requirement_key=p.name) + AF.hostile_cases(eps, requirement_key=p.name, per_field=per_field)
    if p.read_only:
        cases = [c for c in cases if c["method"] not in AF.WRITE]
    return {"plugin": p.id, "endpoints": len(eps), "cases": cases, "scenarios": list(p.scenarios_text)}


def _check_cfg(p, cfg):
    miss = [k for k in p.needs if not cfg.get(k)]
    if miss:
        return "not set up: " + ", ".join(miss)
    u = urlparse(p.base(cfg))
    if u.username or u.password or u.scheme not in ("http", "https") or not u.hostname:
        return "the base address must be http(s) with no user name in it"
    if u.scheme != "https" and u.hostname not in ("localhost", "127.0.0.1"):
        return "the base address must be https"
    tu = cfg.get(p.prefix + "_TOKEN_URL")
    if tu and p.id in TOKEN_HOSTS and not re.search(TOKEN_HOSTS[p.id], urlparse(tu).hostname or ""):
        return "the token address is not a known sign-in host"
    return None


async def run(plugin_id, cfg, fetch, mode="functional", allow_writes=False):
    """-> {ok, detail, data}. `unavailable` is returned, never a pass, when the plugin is not set up or sign-in fails."""
    p = PLUGINS.get(plugin_id)
    if not p:
        return {"unavailable": True, "detail": f"no plugin named {plugin_id}"}
    bad = _check_cfg(p, cfg)
    if bad:
        return {"unavailable": True, "detail": f"{p.name} {bad}"}
    if mode == "plan":
        return {"ok": True, "detail": "plan only", "data": plan(plugin_id, cfg)}
    try:
        auth = await p.login(cfg, fetch)
    except Exception as e:  # noqa: BLE001
        return {"unavailable": True, "detail": str(e)[:160]}
    base = _root(p, cfg)
    try:
        pv = await p.product_version(cfg, fetch, auth)
    except Exception:  # noqa: BLE001
        pv = None
    state = compat(p, pv)
    rng = "-".join(p.supports) if p.supports else "?"
    r = await _dispatch(p, cfg, base, auth, fetch, mode, allow_writes, plugin_id)
    note = {"newer": f"The product ({pv}) is newer than this plugin was written for ({rng}): results may be wrong. Upgrade the {p.name} plugin.",
            "older": f"The product ({pv}) is older than this plugin supports ({rng}): use the plugin release for that version.",
            "unknown": "The product version could not be read, so plugin compatibility is not confirmed."}.get(state, "")
    r["product"] = {"version": pv, "plugin": p.version, "supports": list(p.supports) if p.supports else None, "compat": state}
    if state in ("newer", "older"):
        r["stale"] = True
    if note and isinstance(r.get("detail"), str):
        r["detail"] = f"{r['detail']}. {note}" if state != "unknown" else r["detail"] + f" ({note})"
    return r


async def _dispatch(p, cfg, base, auth, fetch, mode, allow_writes, plugin_id):
    if mode == "functional":
        pl = plan(plugin_id, cfg)
        cases = [{**c, "path": _apply(c["path"], auth)} for c in pl["cases"]]
        res = await AF.run_cases(base, cases, fetch, allow_writes=allow_writes and not p.read_only, headers=auth["headers"])
        s = AF.summary(res)
        return {"ok": s["failed"] == 0, "detail": f"{s['passed']} passed, {s['failed']} failed, {s['skipped']} skipped" + ("; this product is read-only here (no writes are built)" if p.read_only else ""), "data": {"summary": s, "results": res, "scenarios": pl["scenarios"]}}
    if mode == "readback":
        return await _readback(p, cfg, base, auth, fetch, allow_writes)
    if mode == "security":
        return await _security(p, cfg, base, auth, fetch)
    if mode == "perf":
        return _perf(p, cfg)
    return {"unavailable": True, "detail": "mode must be plan, functional, readback, security or perf"}


async def _readback(p, cfg, base, auth, fetch, allow_writes):
    if isinstance(p, Odoo):
        return {"ok": True, "detail": "readback is not built for Odoo yet (its create answers with a list and reads are POST calls)", "data": {"skipped": True}}
    if p.read_only:
        return {"ok": True, "detail": "read-only plugin: nothing is created, so nothing is read back", "data": {"skipped": True}}
    if not allow_writes:
        return {"ok": True, "detail": "needs allowWrites: it creates one tagged record, reads it back and removes it", "data": {"skipped": True}}
    e = p.entities()[0]
    name = f"{TAG}-{int(time.time())}"
    h = {"Content-Type": "application/json", **auth["headers"]}
    key = next(k for k, v in (e["schema"]["properties"] if "properties" in e["schema"] else {}).items() if v.get("type") == "string")
    if isinstance(p, SuiteCRM):
        body = {"data": {"type": e["name"], "attributes": {next(iter(e["schema"]["required"])): name}}}
    elif isinstance(p, _Ticketing):
        body = {"Ticket": {"Title": name, "Queue": cfg.get(p.prefix + "_QUEUE", "Raw"), "State": "new", "Priority": "3 normal", "CustomerUser": cfg.get(p.prefix + "_USER", "")}, "Article": {"Subject": name, "Body": "Phoenix readback check", "ContentType": "text/plain; charset=utf8"}}
    else:
        body = {next(iter(e["schema"]["required"])): name}
    st, tx = await fetch("POST", base + _apply(e["create"], auth), h, json.dumps(body))
    if st >= 300:
        return {"ok": False, "detail": f"create refused ({st})", "data": {}}
    try:
        doc = json.loads(tx) if tx else {}
    except Exception:
        doc = {}
    rid = doc
    for part in e["id_in"].split("."):
        rid = rid.get(part) if isinstance(rid, dict) else None
    if rid is None:
        return {"ok": False, "detail": "created, but the answer carried no id to read back", "data": {}}
    st2, tx2 = await fetch("GET", base + _apply(e["item"].replace("{id}", str(rid)), auth), {k: v for k, v in h.items() if k != "Content-Type"}, None)
    seen = name in (tx2 or "")
    removed = None
    if e.get("delete") and not isinstance(p, _Ticketing):
        st3, _ = await fetch("DELETE", base + _apply(e["item"].replace("{id}", str(rid)), auth), {k: v for k, v in h.items() if k != "Content-Type"}, None)
        removed = st3 < 300
    return {"ok": st2 < 300 and seen, "detail": ("read back and matched" if seen else "the record read back does not carry what was written") + (", removed" if removed else (", NOT removed" if removed is False else ", left in place (this product's API does not delete)")),
            "data": {"id": str(rid), "tag": name, "removed": removed}}


async def _security(p, cfg, base, auth, fetch):
    gets = [e for e in p.endpoints(cfg) if e["method"] == "GET" or e.get("safe")][:4]
    probes, anon, bad = [], {"Accept": "application/json"}, {"Accept": "application/json", "Authorization": "Bearer phoenix-invalid-token"}
    for e in gets:
        path = _fill_id(e)
        for label, hdr in (("without credentials", anon), ("with a bad token", bad)):
            try:
                st, tx = await fetch(e["method"], base + path, hdr, json.dumps(((e.get("testData") or {}).get("request") or {}).get("valid") or {}) if e["method"] != "GET" else None)
            except Exception as ex:  # noqa: BLE001
                probes.append({"check": f"{e['summary']} {label}", "result": "failed", "detail": f"call failed: {str(ex)[:80]}"})
                continue
            why = []
            if st < 300:
                why.append(f"answered {st} to an unauthenticated call")
            if st >= 500:
                why.append(f"server error {st}")
            if LEAK.search(tx or ""):
                why.append("the error body leaks internals (stack trace, SQL or runtime error)")
            probes.append({"check": f"{e['summary']} {label}", "result": "failed" if why else "passed", "status": st, "detail": "; ".join(why) or "refused cleanly"})
    probes.append({"check": "address uses https", "result": "passed" if p.base(cfg).startswith("https://") else "failed", "detail": p.base(cfg).split("//")[0]})
    f = sum(1 for x in probes if x["result"] == "failed")
    return {"ok": f == 0, "detail": f"{len(probes) - f} of {len(probes)} security checks passed", "data": {"checks": probes}}


def _fill_id(e):
    return re.sub(r"\{(\w+)\}", "1", e["path"])


def _perf(p, cfg):
    eps = [e for e in p.endpoints(cfg) if e["method"] == "GET" or e.get("safe")][:6]
    paths = [_fill_id(e) for e in eps]
    bodies = [(((e.get("testData") or {}).get("request") or {}).get("valid") if e["method"] != "GET" else None) for e in eps]
    lf = ("import os\nfrom locust import HttpUser, task, between\n\n\nclass ProductUser(HttpUser):\n    wait_time = between(1, 3)\n\n    def on_start(self):\n"
          "        self.client.headers.update({'Authorization': 'Bearer ' + os.environ['PRODUCT_TOKEN']})   # the token is read when the test runs, never written here\n\n"
          + "".join(f"    @task\n    def read_{i}(self):\n        self.client.{'post' if b is not None else 'get'}({pth!r}, name={pth.split('?')[0]!r}{', json=' + repr(b) if b is not None else ''})\n\n" for i, (pth, b) in enumerate(zip(paths, bodies))))
    return {"ok": True, "detail": f"{len(paths)} read-only calls planned (no create, change or delete in a load test)", "data": {"paths": paths, "locustfile": lf, "tokenFrom": "PRODUCT_TOKEN"}}
