import { useState } from "react";
import { api } from "../api.js";
import { Card, Chip, ErrorNote, useLoad } from "../ui.jsx";

const TABLES = { agent_events: "Agent events", mcp_calls: "MCP calls", user_actions: "User history", release_results: "Release results", defects: "Defects", unit_results: "Unit and integration results" };
export default function Logs() {
  const [table, setTable] = useState("agent_events"), [project, setProject] = useState(""), [agent, setAgent] = useState("");
  const sum = useLoad(() => api.logSummary(project), [project]);
  const t = useLoad(() => api.logTable(table, { project, agent: table === "agent_events" ? agent : "", n: 200 }), [table, project, agent]);
  const rows = t.data ? t.data.rows : [];
  const cols = rows.length ? Object.keys(rows[0]) : [];
  return (
    <div className="page">
      <div><h1>Logs</h1><div className="sub">Everything the agents, the MCP server and the users do is stored in ClickHouse, masked, and keyed by project. Secrets, card numbers, emails and phone numbers never reach the store.</div></div>
      <div className="row"><input placeholder="project id" value={project} onChange={(e) => setProject(e.target.value)} style={{ maxWidth: 240 }} />
        {table === "agent_events" ? <input placeholder="agent (e.g. runner)" value={agent} onChange={(e) => setAgent(e.target.value)} style={{ maxWidth: 200 }} /> : null}
        {sum.data ? <Chip kind={sum.data.backend === "clickhouse" ? "ok" : "warn"}>{sum.data.backend === "clickhouse" ? "stored in ClickHouse" : "memory only (lost on restart)"}</Chip> : null}</div>
      {sum.data && sum.data.status.note ? <div className="sub">{sum.data.status.note}</div> : null}
      <div className="row" style={{ flexWrap: "wrap" }}>{Object.entries(TABLES).map(([k, v]) => <button key={k} className={`chip ${table === k ? "info" : "mut"}`} onClick={() => setTable(k)}>{v}{sum.data && sum.data.counts[k] != null ? ` · ${sum.data.counts[k]}` : ""}</button>)}</div>
      <ErrorNote error={t.error} />
      <Card>{rows.length ? <div style={{ overflowX: "auto" }}><table><thead><tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr></thead><tbody>
        {rows.map((r, i) => <tr key={i}>{cols.map((c) => <td key={c} className={c === "at" ? "sub" : ""}>{String(r[c] ?? "").slice(0, c === "at" ? 19 : 160)}</td>)}</tr>)}</tbody></table></div> : <span className="sub">No rows yet.</span>}</Card>
    </div>
  );
}
