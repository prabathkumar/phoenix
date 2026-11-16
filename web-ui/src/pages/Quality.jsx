import { useState } from "react";
import { api } from "../api.js";
import { Card, Chip, ErrorNote, pct, useLoad } from "../ui.jsx";

const RATE = { N: ["bad", "No evidence"], P: ["warn", "Partial"], L: ["info", "Largely"], F: ["ok", "Fully"] };
const Tile = ({ label, value, hint }) => <div className="card" style={{ minWidth: 150 }}><div className="sub">{label}</div><div style={{ fontSize: 26, fontWeight: 700 }}>{value}</div>{hint ? <div className="sub">{hint}</div> : null}</div>;

export default function Quality() {
  const [project, setProject] = useState("");
  const [days, setDays] = useState(30);
  const r = useLoad(() => api.kpi(project, days), [project, days]);
  const lc = useLoad(() => api.lifecycle(project), [project]);
  const k = r.data && r.data.kpis, qd = r.data && r.data.quality, t = r.data && r.data.tmmi;
  return (
    <div className="page">
      <div><h1>Quality and TMMI</h1><div className="sub">Measured from the platform's own logs by the Measure agent. A number with no data shows – and says why; nothing is estimated. Code quality comes from Semgrep (already part of TestOps).</div></div>
      <div className="row"><input placeholder="project id (all projects if empty)" value={project} onChange={(e) => setProject(e.target.value)} style={{ maxWidth: 280 }} />
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}>{[7, 30, 90, 365].map((d) => <option key={d} value={d}>last {d} days</option>)}</select>
        {r.data ? <Chip kind="mut">source: {r.data.dataSource}</Chip> : null}</div>
      <ErrorNote error={r.error} />
      {k ? <>
        <div className="row" style={{ flexWrap: "wrap" }}>
          <Tile label="Pass rate" value={pct(k.passRate)} hint={`${k.caseRuns} case runs, ${k.releases} releases`} />
          <Tile label="Flaky rate" value={pct(k.flakyRate)} hint={`auto-heal ${pct(k.autoHealRate)}`} />
          <Tile label="Defect leakage" value={pct(qd.defectLeakage)} hint="reached production / all defects" />
          <Tile label="Defect detection (DDP)" value={pct(qd.defectDetectionPercentage)} hint="found before production" />
          <Tile label="Unit-test leakage" value={pct(qd.unitTestLeakage)} hint={`${qd.unitTestableDefects} unit-testable defects`} />
          <Tile label="Test case effectiveness" value={qd.testCaseEffectiveness == null ? "–" : qd.testCaseEffectiveness} hint="defects per case run" />
          <Tile label="Case time p95" value={k.caseSecondsP95 == null ? "–" : `${k.caseSecondsP95}s`} hint={`p50 ${k.caseSecondsP50 == null ? "–" : k.caseSecondsP50 + "s"}`} />
          <Tile label="Model call failures" value={pct(k.modelCallFailRate)} hint={`${k.modelCalls} calls · MCP errors ${pct(k.mcpErrorRate)}`} />
        </div>
        {qd.note ? <Card><span className="sub">{qd.note}</span></Card> : null}
        <Card><b>Where defects are found</b><div className="sub">Leakage of a phase = the share of its defects that got past it.</div>
          <table><thead><tr><th>Phase</th><th>Defects found</th><th>Leaked past it</th></tr></thead><tbody>
            {["unit", "integration", "system", "uat", "production"].map((p) => <tr key={p}><td>{p}</td><td>{qd.byPhase[p]}</td><td>{p === "production" ? "–" : pct(qd.phaseLeakage[p])}</td></tr>)}</tbody></table></Card>
        {r.data.flakyCases.length || r.data.slowest.length ? <Card><b>Flaky and slow cases</b>
          <div className="sub">Flaky: {r.data.flakyCases.map((c) => `${c.case} (${c.times}x)`).join(", ") || "none"}</div>
          <div className="sub">Slowest: {r.data.slowest.map((c) => `${c.case} ${c.seconds}s`).join(", ") || "none"}</div></Card> : null}
        {t ? <Card hi><b>TMMI view</b> <Chip kind={t.achieved >= 3 ? "ok" : "warn"}>indicative level {t.achieved}</Chip>
          <div className="sub">{t.note}</div>
          {Object.entries(t.levels).map(([lvl, d]) => <div key={lvl} style={{ marginTop: 10 }}><b>Level {lvl}</b> <Chip kind={d.met ? "ok" : "mut"}>{d.met ? "met" : "not met"}</Chip>
            <table><thead><tr><th>Process area</th><th>Rating</th><th>Evidence</th><th>Still missing</th></tr></thead><tbody>
              {Object.entries(d.areas).map(([n, a]) => <tr key={n}><td>{n}</td><td><Chip kind={RATE[a.rating][0]}>{RATE[a.rating][1]}</Chip></td><td className="sub">{a.evidence}</td><td className="sub">{a.missing}</td></tr>)}</tbody></table></div>)}
          {t.nextSteps.length ? <div style={{ marginTop: 10 }}><b>Next steps</b><ul>{t.nextSteps.map((n) => <li key={n} className="sub">{n}</li>)}</ul></div> : null}</Card> : null}
      </> : null}
      <Lifecycle lc={lc} />
    </div>
  );
}

function Lifecycle({ lc }) {
  const d = lc.data;
  return (
    <Card><b>Requirements, end to end</b>
      <div className="sub">Each requirement followed from the requirement itself to its test cases, sign-off, unit and integration tests, release execution and open defects. Put the requirement key (for example PROJ-123) in the case and in each unit test's name.</div>
      <ErrorNote error={lc.error} />
      {d && d.note ? <div className="sub">{d.note}</div> : null}
      {d && d.requirements.length ? <>
        <div className="sub">{d.summary.done} of {d.summary.requirements} requirements are done end to end{d.unlinkedTests ? ` · ${d.unlinkedTests} test(s) carry no requirement key` : ""}</div>
        <div style={{ overflowX: "auto" }}><table><thead><tr><th>Requirement</th>{d.stages.map((s) => <th key={s.id}>{s.label}</th>)}<th>Unit runs</th><th>Integration runs</th></tr></thead><tbody>
          {d.requirements.map((r) => <tr key={r.requirement}><td><b>{r.requirement}</b>{r.done ? <> <Chip kind="ok">done</Chip></> : null}</td>
            {d.stages.map((s) => <td key={s.id}>{r.reached[s.id] ? <Chip kind="ok">yes</Chip> : <Chip kind="bad">no</Chip>}</td>)}
            <td className="sub">{r.unit.runs} run(s){r.unit.languages.length ? ` · ${r.unit.languages.join(", ")}` : ""}{r.unit.flaky.length ? ` · flaky: ${r.unit.flaky.length}` : ""}</td>
            <td className="sub">{r.integration.runs} run(s){r.integration.flaky.length ? ` · flaky: ${r.integration.flaky.length}` : ""}</td></tr>)}</tbody></table></div></> : null}
    </Card>
  );
}
