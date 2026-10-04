"""
Example Django REST Framework view for TestOps' backend (confirmed
stack: Django 4.2.11, DRF 3.14.0) to call TestOps Mobile's experimental
semantic-action endpoint. This wraps testops_semantic_action_client.py
(same directory) — read that file's header first for the full contract
(response shapes, when TESTOPS_MOBILE_ENABLE_SEMANTIC_API is required, why a
{"success": false} result is not an error).

This is a starting point to adapt into TestOps' actual app structure
(its own URLconf, permission classes, serializers), not a drop-in
final file — it assumes nothing about TestOps' existing views beyond
"DRF 3.14 on Django 4.2".

Suggested urls.py wiring:
    path("testops-mobile/semantic-action/", SemanticActionView.as_view())

Settings (add to TestOps' Django settings, not hardcoded here — a
running TestOps Mobile instance's URL is deployment-specific and will differ
between local dev, staging, and wherever the device host actually is):
    TESTOPS_MOBILE_BASE_URL = env("TESTOPS_MOBILE_BASE_URL", default="http://localhost:8091")
"""

from __future__ import annotations

from django.conf import settings
from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from .testops_semantic_action_client import SemanticActionError, run_semantic_action


class SemanticActionRequestSerializer:
    """
    Plain validation helper rather than a full DRF Serializer, since
    this is a pass-through to TestOps Mobile's own JSON contract (see
    engine/semantic-act-executor.js) and there's no model behind it in
    TestOps to serialize against. Swap for a real
    `rest_framework.serializers.Serializer` subclass if TestOps'
    conventions prefer that everywhere — the validation rules are the
    same ones frontend/semantic-action-endpoint.js already enforces on
    the TestOps Mobile side, duplicated here only so a bad request fails fast
    with a TestOps-shaped 400 instead of round-tripping to TestOps Mobile first.
    """

    ALLOWED_KINDS = {"tap", "type"}

    @classmethod
    def validate(cls, data: dict) -> tuple[dict | None, dict | None]:
        """Returns (cleaned_data, None) or (None, errors)."""
        instruction = data.get("instruction")
        if not isinstance(instruction, str) or not instruction.strip():
            return None, {"instruction": "This field is required and must be a non-empty string."}

        kind = data.get("kind", "tap")
        if kind not in cls.ALLOWED_KINDS:
            return None, {"kind": f"Must be one of {sorted(cls.ALLOWED_KINDS)}."}

        text = data.get("text")
        if kind == "type" and not isinstance(text, str):
            return None, {"text": 'Required (as a string) when kind is "type".'}

        return {
            "instruction": instruction,
            "kind": kind,
            "text": text,
            "use_visual_grounding": bool(data.get("useVisualGrounding", False)),
        }, None


class SemanticActionView(APIView):
    """
    POST /testops-mobile/semantic-action/

    Runs one semantic action against whatever TestOps Mobile recording session
    is currently active, on behalf of a TestOps user/test run. This is
    a thin proxy — TestOps Mobile owns the actual resolution/execution logic
    (engine/semantic-act-executor.js); this view's job is auth, request
    shaping, and turning TestOps Mobile's response into a TestOps-shaped one.

    Requires TESTOPS_MOBILE_ENABLE_SEMANTIC_API=1 on the target TestOps Mobile
    instance, and a recording session already started there (via
    TestOps Mobile's own upload flow) — this view does not start one.
    """

    permission_classes = [IsAuthenticated]

    def post(self, request: Request) -> Response:
        cleaned, errors = SemanticActionRequestSerializer.validate(request.data)
        if errors:
            return Response({"errors": errors}, status=status.HTTP_400_BAD_REQUEST)

        testops_mobile_base_url = getattr(settings, "TESTOPS_MOBILE_BASE_URL", None)
        if not testops_mobile_base_url:
            # A misconfigured deployment, not a bad request from the
            # caller -- surfaced as 503 rather than a confusing 400/500.
            return Response(
                {"error": "TESTOPS_MOBILE_BASE_URL is not configured for this TestOps instance."},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        try:
            result = run_semantic_action(
                testops_mobile_base_url,
                instruction=cleaned["instruction"],
                kind=cleaned["kind"],
                text=cleaned["text"],
                use_visual_grounding=cleaned["use_visual_grounding"],
            )
        except SemanticActionError as err:
            # TestOps Mobile itself was unreachable -- a transport failure, not
            # "the instruction couldn't be resolved" (that comes back as
            # an ordinary {"success": False} result below, not this
            # branch).
            return Response({"error": str(err)}, status=status.HTTP_502_BAD_GATEWAY)

        # TestOps Mobile's own status code distinguishes success (200) from an
        # unresolved/failed action (422) from no active session (409) --
        # pass that through as-is rather than collapsing everything to
        # 200 with a success flag buried in the body.
        if result.get("success") is True:
            return Response(result, status=status.HTTP_200_OK)
        if "error" in result and "No recording session is active" in result.get("error", ""):
            return Response(result, status=status.HTTP_409_CONFLICT)
        return Response(result, status=status.HTTP_422_UNPROCESSABLE_ENTITY)
