import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App.jsx";

const dash = {
  days: 14, stores: { postgres: "postgresql", analytics: { backend: "memory", note: "CLICKHOUSE_URL is not set: rows are kept in memory and lost on restart" } },
  execution: { total: 4, passRate: 0.75, passed: 3, failed: 1, perDay: [{ day: "2026-10-30", passed: 3, failed: 1, other: 0 }], byWho: { ai: { passed: 2, failed: 1 }, human: { passed: 1, failed: 0 } }, topFailing: [{ caseId: "TC-2", failures: 1 }] },
  signoff: { cases: { draft: 1, pending: 1, approved: 2, rejected: 0, "changes-requested": 0 }, runs: { pending: 1, approved: 0, rejected: 0 }, totalCases: 4, waitingOnYou: [{ id: 5, kind: "case", subject: "TC-1", requestedBy: "alice", since: "2026-10-30T10:00:00" }] },
  ai: { source: "memory", calls: { total: 12, ok: 11, p50: 120, p95: 900, fellBack: 2 }, byModel: [{ model: "llama3", calls: 12, p95: 900 }], byPrompt: [], guardrailHits: [{ hit: "no-pii", count: 3 }], perDay: [], evals: [{ metric: "toxicity", n: 4, avg: 0.1, passRate: 1 }], stages: [{ stage: "sast", runs: 3, failed: 1, needsYou: 0, avgMs: 40 }] },
  runs: [],
};
const routes = {
  "GET /api/dashboard": () => dash,
  "GET /api/runs": () => ({ runs: [{ id: "run-20261031000000-abcdef", at: "2026-10-31T00:00:00", goal: "test login", requirement: "REQ-1", execution: "failed", defects: 1 }] }),
  "GET /api/cases": () => ({ cases: [{ id: "TC-1", title: "User can log in", steps: ["open", "sign in"], requirement: "REQ-1", priority: "High", who: "ai", signoff: "draft" }, { id: "TC-2", title: "User can pay", steps: [], requirement: "REQ-1", priority: "Medium", who: "human", signoff: "approved" }] }),
  "GET /api/signoff": () => ({ funnel: { cases: { draft: 1, pending: 1, approved: 2, rejected: 0, "changes-requested": 0 }, runs: { pending: 0, approved: 0, rejected: 0 } }, signoffs: [{ id: 5, kind: "case", subject: "TC-1", status: "pending", requestedBy: "alice", decidedBy: "", note: "", createdAt: "2026-10-30T10:00:00", trail: [{ action: "requested", actor: "alice", note: "", at: "2026-10-30T10:00:00" }] }] }),
};
let calls;
beforeEach(() => {
  calls = [];
  localStorage.clear();
  global.fetch = vi.fn(async (url, init = {}) => {
    const key = `${init.method || "GET"} ${String(url).split("?")[0]}`;
    calls.push({ key, init });
    const h = routes[key];
    if (!h) return { ok: false, status: 404, json: async () => ({ detail: `no route ${key}` }) };
    const out = await h(init);
    if (out && out.__error) return { ok: false, status: 400, json: async () => ({ detail: out.__error }) };
    return { ok: true, status: 200, json: async () => out };
  });
});
afterEach(() => vi.restoreAllMocks());
const at = (path) => render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>);

describe("monitoring dashboard", () => {
  it("shows execution, sign-off and AI health, and says when telemetry is only in memory", async () => {
    at("/dashboard");
    expect(await screen.findByText("Monitoring")).toBeInTheDocument();
    expect(screen.getByText("75%")).toBeInTheDocument();
    expect(screen.getByText(/AI telemetry: CLICKHOUSE_URL is not set/)).toBeInTheDocument();
    expect(screen.getByText("120 / 900 ms")).toBeInTheDocument();
    expect(screen.getByText("TC-2")).toBeInTheDocument();
    expect(screen.getByText(/memory \(ClickHouse not set up\)/)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /per day/ })).toBeInTheDocument();
  });
});

describe("test cases and sign-off", () => {
  it("requests sign-off only for the selected cases", async () => {
    routes["POST /api/signoff/case/TC-1/request"] = () => ({ id: 9 });
    at("/cases");
    await userEvent.click(await screen.findByLabelText("Select TC-1"));
    await userEvent.click(screen.getByRole("button", { name: "Request sign-off" }));
    await waitFor(() => expect(calls.some((c) => c.key === "POST /api/signoff/case/TC-1/request")).toBe(true));
    expect(calls.some((c) => c.key === "POST /api/signoff/case/TC-2/request")).toBe(false);
    expect(screen.getAllByText("Approved").length).toBeGreaterThan(0);
  });

  it("warns that unapproved cases will not pass a release sign-off", async () => {
    at("/cases");
    await userEvent.click(await screen.findByLabelText("Select TC-1"));
    await userEvent.click(screen.getByRole("button", { name: /Start run/ }));
    const dlg = await screen.findByRole("dialog");
    expect(within(dlg).getByText(/not approved yet/)).toBeInTheDocument();
  });

  it("shows the server's four-eyes refusal, and disables approve for the requester", async () => {
    localStorage.setItem("phoenix.user", "alice");
    routes["POST /api/signoff/5/decide"] = () => ({ __error: "The person who asked for sign-off cannot approve it. Ask a colleague." });
    at("/signoff");
    expect(await screen.findByText(/You asked for this sign-off/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
  });

  it("sends the decision and the signed-in name", async () => {
    localStorage.setItem("phoenix.user", "bob");
    routes["POST /api/signoff/5/decide"] = () => ({ id: 5, status: "approved" });
    at("/signoff");
    await userEvent.type(await screen.findByLabelText(/Note/), "looks right");
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(calls.some((c) => c.key === "POST /api/signoff/5/decide")).toBe(true));
    const c = calls.find((x) => x.key === "POST /api/signoff/5/decide");
    expect(JSON.parse(c.init.body)).toEqual({ decision: "approved", note: "looks right" });
    expect(c.init.headers["X-User"]).toBe("bob");
  });
});

describe("shell", () => {
  it("lists the menu and marks unbuilt items as soon", async () => {
    routes["GET /api/gateway/prompts"] = () => ({ prompts: [] });
    at("/gateway");
    const nav = await screen.findByRole("navigation", { name: "Main" });
    expect(within(nav).getByRole("link", { name: /Sign-off/ })).toBeInTheDocument();
    expect(within(nav).getByText(/Scheduler · soon/)).toBeInTheDocument();
    expect(await screen.findByText(/library is empty/)).toBeInTheDocument();
  });

  it("landing sends a pasted link as a requirement URL and plans only the safe stages", async () => {
    routes["POST /api/pipeline/run"] = () => ({ runId: "run-20261031000000-abcdef" });
    routes["GET /api/runs/run-20261031000000-abcdef"] = () => ({ run: { id: "run-20261031000000-abcdef", goal: "x", plan: { source: "ai" }, stages: [] }, calls: [], executions: [], checks: { pass: true, checks: [] } });
    at("/");
    await userEvent.type(await screen.findByLabelText(/Tell me/), "https://example.com/req.pdf");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(calls.some((c) => c.key === "POST /api/pipeline/run")).toBe(true));
    const body = JSON.parse(calls.find((c) => c.key === "POST /api/pipeline/run").init.body);
    expect(body.requirementUrl).toBe("https://example.com/req.pdf");
    expect(body.stages).not.toContain("dast");
    expect(body.stages).not.toContain("defects");
    expect(await screen.findByRole("heading", { name: "AI Test Manager" })).toBeInTheDocument();
  });
});
