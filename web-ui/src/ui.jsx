import { useEffect, useState } from "react";

export const Chip = ({ kind = "mut", children, ...p }) => <span className={`chip ${kind}`} {...p}>{children}</span>;
export const Card = ({ hi, children, ...p }) => <section className={`card${hi ? " hi" : ""}`} {...p}>{children}</section>;
export const Btn = ({ pri, children, ...p }) => <button className={`btn${pri ? " pri" : ""}`} {...p}>{children}</button>;
export const ErrorNote = ({ error }) => (error ? <div className="err" role="alert">{String(error.message || error)}</div> : null);

export const STATUS = { passed: ["ok", "Passed"], failed: ["bad", "Failed"], "needs-you": ["warn", "Needs you"], skipped: ["mut", "Skipped"], "not-built": ["mut", "Not built"], unavailable: ["warn", "Not set up"] };
export const StatusChip = ({ status }) => { const [k, t] = STATUS[status] || ["mut", status]; return <Chip kind={k}>{t}</Chip>; };
export const SIGNOFF = { draft: ["mut", "Draft"], pending: ["warn", "Waiting for sign-off"], approved: ["ok", "Approved"], rejected: ["bad", "Rejected"], "changes-requested": ["warn", "Changes requested"] };
export const SignoffChip = ({ state }) => { const [k, t] = SIGNOFF[state] || ["mut", state]; return <Chip kind={k}>{t}</Chip>; };

/** Loads once, exposes {data, error, loading, reload}. */
export function useLoad(fn, deps = []) {
  const [s, set] = useState({ data: null, error: null, loading: true });
  const load = () => { set((x) => ({ ...x, loading: true })); return fn().then((data) => set({ data, error: null, loading: false }), (error) => set({ data: null, error, loading: false })); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, deps);
  return { ...s, reload: load };
}
export const pct = (x) => (x == null ? "–" : `${Math.round(x * 100)}%`);
