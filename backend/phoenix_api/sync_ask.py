"""One way to ask the model from plain (non-async) code. call_json is the platform's callable: call_json(text) -> dict, usually async."""
import asyncio
import concurrent.futures
import inspect


def ask(call_json, instruction, payload):
    r = call_json(f"{instruction}\n\n{payload}")
    if inspect.isawaitable(r):
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return asyncio.run(r)
        with concurrent.futures.ThreadPoolExecutor(1) as ex:  # already inside a loop: run in a fresh thread
            return ex.submit(asyncio.run, r).result()
    return r
