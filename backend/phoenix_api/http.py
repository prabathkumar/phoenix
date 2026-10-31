"""One small HTTP seam so every client can be tested with a fake.
A fetch is `async (method, url, headers=None, body=None) -> (status:int, text:str)`."""
import httpx


async def fetch(method, url, headers=None, body=None, timeout=60):
    async with httpx.AsyncClient(timeout=timeout) as c:
        r = await c.request(method, url, headers=headers, content=body)
        return r.status_code, r.text
