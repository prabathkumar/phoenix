from phoenix_api import change_impact as ci

FILES = [
    {"path": "src/billing/invoice.py", "status": "modified", "patch": "+def apply_discount(order):\n+    return order\n+ROUTE = '/api/discount'\n"},
    {"path": "src/auth/login.py", "status": "modified", "patch": "+def verify_otp(code):\n+    # send the one-time code by SMS\n"},
    {"path": "src/web/upload.js", "status": "added", "patch": "+function uploadAvatar(file) {\n+  // multipart upload\n+}\n"},
    {"path": "tests/test_billing.py", "status": "modified", "patch": "+def test_x(): pass\n"},
    {"path": "README.md", "status": "modified", "patch": "+docs"},
    {"path": "src/old.py", "status": "removed", "patch": ""},
]
CASES = [{"id": 1, "name": "Discount applied to the order", "text": "enter an order, apply discount, expect the total is lower"},
         {"id": 2, "name": "Login with a valid password", "text": "open login page"}]


def test_only_product_code_that_changed_is_scanned():
    r = ci.scan(FILES, CASES)
    assert [c["path"] for c in r["changes"]] == ["src/billing/invoice.py", "src/auth/login.py", "src/web/upload.js"]  # no tests, docs or removed files
    assert r["summary"] == {"changed_files": 6, "relevant": 3, "uncovered": 1}


def test_covered_and_uncovered_changes():
    by = {c["path"]: c for c in ci.scan(FILES, CASES)["changes"]}
    assert by["src/billing/invoice.py"]["covered_by"] == [1] and not by["src/billing/invoice.py"]["gap"]
    assert by["src/auth/login.py"]["covered_by"] == [2]  # case 2 mentions login
    assert by["src/web/upload.js"]["gap"] and by["src/web/upload.js"]["covered_by"] == []


def test_human_steps_are_spotted_in_code_and_in_test_steps():
    r = ci.scan(FILES, CASES)
    assert r["human_wait"] == ["2FA / one-time code", "file upload"]
    assert ci.human_waits("Enter the OTP sent by SMS, then attach the invoice file") == ["2FA / one-time code", "file upload"]
    assert ci.human_waits("Click save and check the total") == []


def test_model_can_cover_and_draft_the_missing_case():
    async def model(text):
        return {"covered": [{"path": "src/web/upload.js", "case_ids": [999, 2]}],  # 999 is not a real case and is ignored
                "missing": [{"path": "src/auth/login.py", "why": "one-time code is new", "case": {"name": "Login asks for the OTP", "steps": "log in; enter OTP", "expected": "signed in"}}]}
    r = ci.scan(FILES, [{"id": 5, "name": "x", "text": ""}] + CASES, call_json=model)
    by = {c["path"]: c for c in r["changes"]}
    assert r["source"] == "model"
    assert by["src/web/upload.js"]["covered_by"] == [2] and not by["src/web/upload.js"]["gap"]
    # login.py was covered by the rules (case 2 mentions login) so the model's 'missing' does not override a case that exists
    assert by["src/auth/login.py"]["suggested_case"] is None
