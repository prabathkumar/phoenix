"""Requirements from anywhere: public link, uploaded file, pasted text, or Jira key.
Formats: HTML, Markdown, text, CSV, JSON (OpenAPI becomes an endpoint list), Word, Excel, PowerPoint, PDF (pdftotext), Jira links (via the Jira connection).
Links are fetched with guards: http(s) only, no credentials in the URL, private/loopback/link-local/metadata addresses refused, the checked IP is the one
connected to (a DNS trick cannot swap it), redirects re-checked, 8MB / 20s limits. What comes back is untrusted data for the model, never run."""
import asyncio
import base64
import html as _html
import io
import ipaddress
import json
import re
import socket
import subprocess
import zipfile
from urllib.parse import urljoin, urlparse

import httpx

MAX_BYTES, MAX_TEXT, MAX_REDIRECTS, TIMEOUT = 8 * 1024 * 1024, 60000, 4, 20


def private_address(ip):
    a = ipaddress.ip_address(ip.split("%")[0])
    if isinstance(a, ipaddress.IPv6Address) and a.ipv4_mapped:
        a = a.ipv4_mapped
    return a.is_private or a.is_loopback or a.is_link_local or a.is_multicast or a.is_reserved or a.is_unspecified or (isinstance(a, ipaddress.IPv4Address) and ipaddress.ip_address("100.64.0.0") <= a <= ipaddress.ip_address("100.127.255.255"))


async def _resolve(host):
    try:
        return [ipaddress.ip_address(host).compressed]
    except ValueError:
        pass
    infos = await asyncio.get_running_loop().getaddrinfo(host, None, type=socket.SOCK_STREAM)
    return list(dict.fromkeys(i[4][0] for i in infos))


async def fetch_public(url, allow_private=False, resolve=_resolve, client_factory=None):
    """GET with redirects checked at every hop. Returns {url, type, body(bytes)}."""
    cur = url
    for _ in range(MAX_REDIRECTS + 1):
        u = urlparse(cur)
        if u.scheme not in ("http", "https"):
            raise ValueError("Only http and https links are allowed.")
        if u.username or u.password:
            raise ValueError("Links with a username or password in them are not allowed.")
        ips = await resolve(u.hostname)
        if not ips:
            raise ValueError("The address could not be resolved.")
        if not allow_private and any(private_address(i) for i in ips):
            raise ValueError("That address is on a private network, which is not allowed here.")
        ip = ips[0]
        target = u._replace(netloc=(f"[{ip}]" if ":" in ip else ip) + (f":{u.port}" if u.port else "")).geturl()
        mk = client_factory or (lambda: httpx.AsyncClient(timeout=TIMEOUT, follow_redirects=False, verify=True))
        async with mk() as c:
            req = c.build_request("GET", target, headers={"Host": u.netloc.split("@")[-1], "User-Agent": "phoenix-requirements/1.0", "Accept": "*/*"}, extensions={"sni_hostname": u.hostname})
            r = await c.send(req, stream=True)
            try:
                if r.status_code in (301, 302, 303, 307, 308) and r.headers.get("location"):
                    cur = urljoin(cur, r.headers["location"])
                    continue
                if r.status_code >= 400:
                    raise ValueError(f"The link answered {r.status_code}. Private pages need a sign-in or a downloaded copy.")
                body = b""
                async for chunk in r.aiter_bytes():
                    body += chunk
                    if len(body) > MAX_BYTES:
                        raise ValueError("The file is larger than 8MB.")
                return {"url": cur, "type": r.headers.get("content-type", "").split(";")[0].lower(), "body": body}
            finally:
                await r.aclose()
    raise ValueError("Too many redirects.")


def _xml_text(s):
    s = re.sub(r"</w:p>|</a:p>|</row>|</si>", "\n", s or "")
    s = re.sub(r"</w:tc>|</c>", "\t", s).replace("<w:tab/>", "\t")
    return _html.unescape(re.sub(r"<[^>]+>", "", s))


def _zip(buf):
    try:
        z = zipfile.ZipFile(io.BytesIO(buf))
    except zipfile.BadZipFile:
        raise ValueError("Not a valid Office file.")
    out = {}
    for n in z.namelist():
        if re.search(r"\.(xml|rels)$", n):
            info = z.getinfo(n)
            if info.file_size > 20 * 1024 * 1024:
                continue
            out[n] = z.read(n).decode("utf-8", "replace")
    return out


def docx_text(buf):
    return _xml_text(_zip(buf).get("word/document.xml"))


def pptx_text(buf):
    f = _zip(buf)
    keys = sorted((k for k in f if re.fullmatch(r"ppt/slides/slide\d+\.xml", k)), key=lambda k: int(re.search(r"\d+", k).group()))
    return "\n".join(f"Slide {i + 1}:\n{_xml_text(f[k])}" for i, k in enumerate(keys))


def xlsx_text(buf):
    f = _zip(buf)
    shared = [_xml_text(m).strip() for m in re.findall(r"<si>([\s\S]*?)</si>", f.get("xl/sharedStrings.xml", ""))]
    sheets = sorted(k for k in f if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", k))
    out = []
    for i, k in enumerate(sheets):
        rows = []
        for r in re.findall(r"<row[^>]*>([\s\S]*?)</row>", f[k]):
            cells = []
            for m in re.finditer(r"<c(\s[^>]*?)?(?:/>|>([\s\S]*?)</c>)", r):
                attrs, inner = m.group(1) or "", m.group(2) or ""
                v, inline = re.search(r"<v>([\s\S]*?)</v>", inner), re.search(r"<is>([\s\S]*?)</is>", inner)
                cells.append((shared[int(v.group(1))] if v and shared and int(v.group(1)) < len(shared) else "") if re.search(r't="s"', attrs) and v else _xml_text(inline.group(1)) if inline else v.group(1) if v else "")
            rows.append(" | ".join(cells))
        out.append(f"Sheet {i + 1}:\n" + "\n".join(rows))
    return "\n\n".join(out)


def html_text(h):
    s = re.sub(r"<(script|style|noscript|svg|iframe|template)[\s\S]*?</\1>", " ", str(h), flags=re.I)
    s = re.sub(r"<!--[\s\S]*?-->", " ", s)
    title = re.search(r"<title[^>]*>([\s\S]*?)</title>", s, re.I)
    s = re.sub(r"<h([1-6])[^>]*>", lambda m: "\n" + "#" * int(m.group(1)) + " ", s, flags=re.I)
    s = re.sub(r"<li[^>]*>", "\n- ", s, flags=re.I)
    s = re.sub(r"</(p|div|tr|h[1-6]|section|article|table|ul|ol|br)>|<br\s*/?>", "\n", s, flags=re.I)
    s = re.sub(r"</t[dh]>", " | ", s, flags=re.I)
    s = _html.unescape(re.sub(r"<[^>]+>", "", s))
    s = re.sub(r"[ \t]+", " ", s)
    s = re.sub(r"\n\s*\n+", "\n\n", s).strip()
    return (title.group(1).strip() + "\n\n" if title else "") + s


def json_text(text):
    try:
        j = json.loads(text)
    except Exception:
        return text
    if isinstance(j, dict) and j.get("paths") and (j.get("openapi") or j.get("swagger")):
        lines = [f"API: {(j.get('info') or {}).get('title', '')} {(j.get('info') or {}).get('version', '')}".strip()]
        for p, ops in j["paths"].items():
            for m, op in ops.items():
                if re.fullmatch(r"get|post|put|patch|delete", m):
                    lines.append(f"{m.upper()} {p}: {str((op or {}).get('summary') or (op or {}).get('description') or '')[:200]}")
        return "\n".join(lines)
    return json.dumps(j, indent=2)


def pdf_text(buf, run=subprocess.run):
    try:
        r = run(["pdftotext", "-layout", "-", "-"], input=buf, capture_output=True, timeout=60)
    except (FileNotFoundError, subprocess.TimeoutExpired):
        raise ValueError("Reading PDFs needs pdftotext on this server (poppler-utils).")
    if r.returncode != 0:
        raise ValueError("Reading PDFs needs pdftotext on this server (poppler-utils).")
    return r.stdout.decode("utf-8", "replace")


def detect(name, typ, buf):
    m = re.search(r"\.([A-Za-z0-9]+)$", str(name).split("?")[0])
    e = m.group(1).lower() if m else ""
    if buf[:4] == b"%PDF":
        return "pdf"
    if buf[:2] == b"PK":
        return "xlsx" if e == "xlsx" or "spreadsheetml" in typ else "pptx" if e == "pptx" or "presentationml" in typ else "docx"
    if e == "csv" or typ == "text/csv":
        return "csv"
    if e == "json" or "json" in typ:
        return "json"
    if e in ("md", "markdown") or typ == "text/markdown":
        return "md"
    if "html" in typ or e in ("html", "htm") or re.match(r"\s*<(!doctype|html)", buf[:200].decode("utf-8", "replace"), re.I):
        return "html"
    return "text"


def to_text(kind, buf, run=subprocess.run):
    return {"pdf": lambda: pdf_text(buf, run), "docx": lambda: docx_text(buf), "xlsx": lambda: xlsx_text(buf), "pptx": lambda: pptx_text(buf),
            "html": lambda: html_text(buf.decode("utf-8", "replace")), "json": lambda: json_text(buf.decode("utf-8", "replace"))}.get(kind, lambda: buf.decode("utf-8", "replace"))()


def _clip(t, notes):
    s = str(t).replace("\x00", "").strip()
    if len(s) > MAX_TEXT:
        notes.append(f"Only the first {MAX_TEXT} characters were used.")
        return s[:MAX_TEXT]
    return s


def jira_key_from_url(u):
    try:
        x = urlparse(u)
        m = re.search(r"/browse/([A-Z][A-Z0-9_]+-\d+)", x.path, re.I)
        if m:
            return m.group(1)
        q = dict(p.split("=", 1) for p in x.query.split("&") if "=" in p)
        return q.get("selectedIssue")
    except Exception:
        return None


async def load_requirement(url=None, file=None, text=None, jira=None, allow_private=False, run=subprocess.run, fetcher=fetch_public):
    notes = []
    if text and str(text).strip():
        return {"text": _clip(text, notes), "source": {"kind": "text", "type": "text", "bytes": len(str(text).encode())}, "notes": notes}
    if file:
        buf = base64.b64decode(str(file.get("base64") or ""), validate=False)
        if not buf:
            raise ValueError("The file is empty.")
        if len(buf) > MAX_BYTES:
            raise ValueError("The file is larger than 8MB.")
        kind = detect(file.get("name") or "", "", buf)
        return {"text": _clip(to_text(kind, buf, run), notes), "source": {"kind": "file", "type": kind, "name": str(file.get("name") or "")[:120], "bytes": len(buf)}, "notes": notes}
    if url:
        key = jira_key_from_url(url)
        if key and jira is not None and not jira.missing:
            from . import jira as J
            r = await J.read_requirement(jira, key)
            notes.append(f"Read through the Jira connection ({key}), with its linked change requests.")
            return {"text": _clip(r["text"], notes), "source": {"kind": "jira", "type": "jira", "name": key}, "notes": notes}
        if key:
            notes.append("This looks like a Jira link. Jira pages need a sign-in, so connect Jira (JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN) to read it; trying as a public page.")
        r = await fetcher(url, allow_private=allow_private)
        kind = detect(r.get("url") or url, r.get("type", ""), r["body"])
        if kind == "html":
            t = html_text(r["body"].decode("utf-8", "replace"))
            if re.search(r"sign in|log in|login", t[:400], re.I) and len(t) < 800:
                notes.append("The page looks like a sign-in screen; it may not be public.")
        return {"text": _clip(to_text(kind, r["body"], run), notes), "source": {"kind": "link", "type": kind, "host": urlparse(r.get("url") or url).netloc, "bytes": len(r["body"])}, "notes": notes}
    raise ValueError("Give a link, a file, pasted text or a Jira key.")
