import { useState } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import { getUser, setUser } from "./api.js";
import Landing from "./pages/Landing.jsx";
import Start from "./pages/Start.jsx";
import Journey from "./pages/Journey.jsx";
import Cases from "./pages/Cases.jsx";
import Result from "./pages/Result.jsx";
import Guided from "./pages/Guided.jsx";
import { Performance, Security, Defects, CodeAnalyzer, AiEval } from "./pages/Stages.jsx";
import Signoff from "./pages/Signoff.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import Gateway from "./pages/Gateway.jsx";
import Runs from "./pages/Runs.jsx";

// Menu from the design, plus the pages the design did not have (sign-off, gateway). `soon` items are not built and say so.
export const MENU = [
  ["AI Test Manager", "/", "M8 2l1.3 3.7L13 7l-3.7 1.3L8 12 6.7 8.3 3 7l3.7-1.3z"],
  ["Dashboards", "/dashboard", "M2.5 2.5h4v4h-4zM9.5 2.5h4v4h-4zM2.5 9.5h4v4h-4zM9.5 9.5h4v4h-4z"],
  ["Test Management", "/cases", "M8 2l6 3-6 3-6-3zM2 8l6 3 6-3M2 11l6 3 6-3"],
  ["Test Lab", "/start", "M6 2.5h4M7 2.5v4L3.5 13a1 1 0 0 0 .9 1.5h7.2a1 1 0 0 0 .9-1.5L9 6.5v-4"],
  ["Sign-off", "/signoff", "M3 8.5l3 3 7-7"],
  ["AI Evaluation", "/eval", "M8 2l1.3 3.7L13 7l-3.7 1.3L8 12 6.7 8.3 3 7l3.7-1.3z"],
  ["Defect Management", "/defects", "M5.5 6h5v4a2.5 2.5 0 0 1-5 0zM8 6V4M5.5 8H3M10.5 8H13M5.5 11L4 12.5M10.5 11L12 12.5"],
  ["Performance Test Lab", "/performance", "M2.5 11a5.5 5.5 0 1 1 11 0M8 11l2.5-3"],
  ["Security Test Lab", "/security", "M8 2l5 2v4c0 3-2.2 5-5 6-2.8-1-5-3-5-6V4z"],
  ["Code Analyzer", "/code", "M6 5L3 8l3 3M10 5l3 3-3 3"],
  ["Reports", "/runs", "M4 2h5l3 3v9H4zM9 2v3h3M6 8h4M6 10.5h4"],
  ["AI Gateway", "/gateway", "M3 5h10M3 11h10M6 3v4M10 9v4"],
  ["Projects", null, "M2 4.5h4l1.5 1.5H14v7H2z"],
  ["Task Management", null, "M3 4.5h10M3 8h10M3 11.5h6"],
  ["Scheduler", null, "M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM8 5v3.2l2 1.3"],
];

function Nav() {
  const [u, setU] = useState(getUser());
  return (
    <nav className="nav" aria-label="Main">
      <div className="brand">FROTH <span>TestOps</span></div>
      {MENU.map(([name, to, d]) => {
        const icon = <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d={d} strokeLinecap="round" strokeLinejoin="round" /></svg>;
        return to ? <NavLink key={name} to={to} end={to === "/"} className={({ isActive }) => (isActive ? "on" : "")}>{icon}<span>{name}</span></NavLink>
          : <a key={name} aria-disabled="true" title="Not built yet" style={{ opacity: .45, cursor: "default" }} onClick={(e) => e.preventDefault()} href="#soon">{icon}<span>{name} · soon</span></a>;
      })}
      <div className="who">
        <label htmlFor="who" style={{ fontSize: 12, fontWeight: 500 }}>You are signed in as</label>
        <input id="who" value={u} placeholder="your name or email" onChange={(e) => { setU(e.target.value); setUser(e.target.value); }} style={{ padding: "7px 9px", fontSize: 12 }} />
        <span>Sign-off decisions are recorded under this name. Real login is the next step.</span>
      </div>
    </nav>
  );
}

export default function App() {
  return (
    <div className="shell">
      <Nav />
      <main>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/start" element={<Start />} />
          <Route path="/journey/:id" element={<Journey />} />
          <Route path="/cases" element={<Cases />} />
          <Route path="/runs" element={<Runs />} />
          <Route path="/runs/:id" element={<Result />} />
          <Route path="/guided/:runId/:caseId" element={<Guided />} />
          <Route path="/performance" element={<Performance />} />
          <Route path="/security" element={<Security />} />
          <Route path="/defects" element={<Defects />} />
          <Route path="/code" element={<CodeAnalyzer />} />
          <Route path="/eval" element={<AiEval />} />
          <Route path="/signoff" element={<Signoff />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/gateway" element={<Gateway />} />
          <Route path="*" element={<div className="page"><h1>Not found</h1></div>} />
        </Routes>
      </main>
    </div>
  );
}
