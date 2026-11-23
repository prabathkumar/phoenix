"""Mobile flow (R10): the same flow as unit tests, for mobile app test cases, triggered and run through TestOps.ai.

draft_cases(requirements, platform, app, call_json=None) -> [{requirement, platform, steps:[{action, locator, value?}], expected, source}]
capabilities(platform, app, device, env)                 -> W3C capabilities for Appium / BrowserStack / Phoenix engine
to_pytest(cases, platform, app)                           -> runnable Appium-Python-client pytest file (needs APPIUM_URL)
submit(cases, platform, app, device, post, env)           -> {ok, available, job, detail}: sends the job to the grid set in env
Status: runs on any Appium-compatible grid (Phoenix engine, BrowserStack, local Appium). Real-device runs were NOT exercised here."""
import json

from .sync_ask import ask

PROMPT = ("You write mobile app test cases. For each requirement give steps (tap/type/swipe/expect_text/expect_visible with an accessibility id) "
          'and the expected result. Reply JSON: {"cases":[{"requirement":"","steps":[{"action":"","locator":"","value":""}],"expected":""}]}')
ACTIONS = {"tap", "type", "swipe", "expect_text", "expect_visible"}


def draft_cases(requirements, platform="android", app="", call_json=None):
    cases = []
    if call_json:
        try:
            out = ask(call_json, PROMPT, json.dumps({"requirements": requirements, "platform": platform, "app": app})[:12000])
            for c in (out or {}).get("cases", []):
                if c.get("requirement") and isinstance(c.get("steps"), list):
                    c["steps"] = [s for s in c["steps"] if s.get("action") in ACTIONS]
                    cases.append({**c, "platform": platform, "source": "model"})
        except Exception:
            cases = []
    have = {c["requirement"] for c in cases}
    for r in requirements:
        k = r.get("key") if isinstance(r, dict) else str(r)
        if k not in have:
            cases.append({"requirement": k, "platform": platform, "steps": [], "expected": "",
                          "source": "draft: app launches only; QA adds steps and accessibility ids"})
    return cases


def capabilities(platform, app, device="", env=None):
    env = env or {}
    p = platform.lower()
    caps = {"platformName": "Android" if p == "android" else "iOS", "appium:automationName": "UiAutomator2" if p == "android" else "XCUITest", "appium:app": app}
    if device:
        caps["appium:deviceName"] = device
    if env.get("TESTOPS_MOBILE_BROWSERSTACK_USER"):
        caps["bstack:options"] = {"userName": env["TESTOPS_MOBILE_BROWSERSTACK_USER"], "accessKey": "set from env on the grid side"}
    return caps


def to_pytest(cases, platform="android", app=""):
    caps = capabilities(platform, app)
    lines = ["import json, os, pytest", "from appium import webdriver", "from appium.options.common import AppiumOptions", "from appium.webdriver.common.appiumby import AppiumBy", "",
             "CAPS = json.loads(" + repr(json.dumps(caps)) + ")", "CASES = json.loads(" + repr(json.dumps(cases)) + ")", "",
             "@pytest.fixture", "def drv():", "    url = os.environ.get('APPIUM_URL')", "    if not url:", "        pytest.skip('set APPIUM_URL')",
             "    o = AppiumOptions(); o.load_capabilities(CAPS)", "    d = webdriver.Remote(url, options=o)", "    yield d", "    d.quit()", "",
             "@pytest.mark.parametrize('c', CASES, ids=[c['requirement'] for c in CASES])", "def test_case(drv, c):",
             "    for s in c['steps']:", "        a = s['action']", "        if a == 'swipe':", "            drv.swipe(100, 800, 100, 200); continue",
             "        el = drv.find_element(AppiumBy.ACCESSIBILITY_ID, s['locator'])",
             "        if a == 'tap': el.click()", "        elif a == 'type': el.send_keys(s.get('value', ''))",
             "        elif a == 'expect_text': assert s.get('value', '') in el.text", "        elif a == 'expect_visible': assert el.is_displayed()"]
    return "\n".join(lines) + "\n"


def submit(cases, platform, app, device, post, env):
    """post(url, json) -> dict. The grid URL comes from env, never from the request."""
    url = env.get("PHOENIX_MOBILE_URL") or env.get("APPIUM_URL")
    if not url:
        return {"ok": False, "available": False, "detail": "no mobile grid configured (PHOENIX_MOBILE_URL or APPIUM_URL)", "job": None}
    job = {"capabilities": capabilities(platform, app, device, env), "cases": cases}
    try:
        res = post(url.rstrip("/") + "/jobs", job)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "available": True, "detail": f"grid did not accept the job: {type(e).__name__}", "job": None}
    return {"ok": True, "available": True, "detail": "", "job": res}
