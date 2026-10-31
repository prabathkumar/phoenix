import { api } from "./api.js";

/** Runs the pipeline and remembers the request, so an approval can send the same request again with approvals added. */
export async function startRun(body) {
  const out = await api.run(body);
  try { sessionStorage.setItem(`phoenix.req.${out.runId}`, JSON.stringify(body)); } catch { /* private window */ }
  return out;
}
export function lastRequest(id) { try { return JSON.parse(sessionStorage.getItem(`phoenix.req.${id}`)); } catch { return null; } }
export async function approve(id, stageId) {
  const body = lastRequest(id);
  if (!body) throw new Error("This run was started in another browser, so the same request cannot be sent again. Start it again from the Test Lab.");
  return startRun({ ...body, approvals: { ...(body.approvals || {}), [stageId]: true } });
}
