import { Link } from "react-router-dom";
import { api } from "../api.js";
import { Card, ErrorNote, StatusChip, useLoad } from "../ui.jsx";

export default function Runs() {
  const { data, error } = useLoad(() => api.runs());
  return (
    <div className="page">
      <h1>Reports</h1>
      <ErrorNote error={error} />
      <Card>
        <table>
          <thead><tr><th>Run</th><th>Goal</th><th>Requirement</th><th>Execution</th><th>Defects</th></tr></thead>
          <tbody>
            {(data ? data.runs : []).map((r) => <tr key={r.id}><td><Link to={`/runs/${r.id}`}>{r.id}</Link><div className="sub">{r.at.slice(0, 16).replace("T", " ")}</div></td><td>{r.goal}</td><td>{r.requirement || "–"}</td><td><StatusChip status={r.execution || "skipped"} /></td><td>{r.defects}</td></tr>)}
            {data && !data.runs.length ? <tr><td colSpan="5" className="sub">No runs yet.</td></tr> : null}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
