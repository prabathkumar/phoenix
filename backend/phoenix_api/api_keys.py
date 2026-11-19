"""API keys for outside callers (an AI coding agent such as ILMU Code, a CI job).
PHOENIX_API_KEYS="ilmu-code:<sha256 of the key>,ci:<sha256>" -- only hashes are kept on the server. The caller sends the key as
`Authorization: Bearer <key>` or `X-API-Key`. With no keys configured the outside API is closed (fail-closed). Make a pair with: python -m phoenix_api.api_keys NAME"""
import hashlib
import hmac
import secrets
import sys


def parse(env):
    out = {}
    for item in str((env or {}).get("PHOENIX_API_KEYS", "")).split(","):
        name, _, h = item.strip().partition(":")
        if name and len(h) == 64:
            out[name.lower()] = h.lower()
    return out


def caller(env, authorization="", x_api_key=""):
    """The caller's name for a valid key, else None. Compares hashes in constant time."""
    key = (x_api_key or (authorization[7:] if authorization.lower().startswith("bearer ") else "")).strip()
    if not key:
        return None
    h = hashlib.sha256(key.encode()).hexdigest()
    found = None
    for name, want in parse(env).items():  # no early exit: every key is compared
        if hmac.compare_digest(h, want):
            found = name
    return found


if __name__ == "__main__":
    k = "phx_" + secrets.token_urlsafe(32)
    print(f"key (give to the caller, shown once): {k}\nPHOENIX_API_KEYS entry: {(sys.argv[1] if len(sys.argv) > 1 else 'caller')}:{hashlib.sha256(k.encode()).hexdigest()}")
