/**
 * Git hosts, one interface: GitHub and GitLab (cloud or self-hosted).
 *   repo = connect({provider:"github"|"gitlab", project:"owner/name", token, baseUrl?, fetchFn?})
 *   repo.defaultBranch() | repo.listFiles(ref) | repo.readFile(path, ref)
 *   repo.openPullRequest({base, branch, title, body, files:[{path, content}]})  -> {url, branch}
 * Tokens: GITHUB_TOKEN / GITLAB_TOKEN, used only in the Authorization header, never returned or logged.
 * Errors name the call and status, never the response body. Not yet run against a real GitHub or GitLab (fake host in tests).
 */
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const unb64 = (s) => Buffer.from(s, "base64").toString("utf8");

function connect({ provider, project, token, baseUrl, fetchFn = globalThis.fetch }) {
  if (!["github", "gitlab"].includes(provider)) throw new Error('provider must be "github" or "gitlab".');
  if (!/^[\w.-]+(\/[\w.-]+)+$/.test(String(project || ""))) throw new Error('project looks like "owner/name".');
  if (!token) throw new Error(`Set ${provider === "github" ? "GITHUB_TOKEN" : "GITLAB_TOKEN"} to connect to ${provider}.`);
  const gh = provider === "github";
  const root = (baseUrl || (gh ? "https://api.github.com" : "https://gitlab.com/api/v4")).replace(/\/+$/, "");
  const id = encodeURIComponent(project);
  async function call(method, path, body) {
    const res = await fetchFn(root + path, { method, headers: { ...(gh ? { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } : { "PRIVATE-TOKEN": token }), "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    if (!res.ok) throw new Error(`${provider} ${method} ${path.split("?")[0]} failed (${res.status}).`);
    return text ? JSON.parse(text) : {};
  }
  const api = {
    provider, project,
    async defaultBranch() { const r = await call("GET", gh ? `/repos/${project}` : `/projects/${id}`); return r.default_branch; },
    async listFiles(ref) {
      if (gh) return ((await call("GET", `/repos/${project}/git/trees/${encodeURIComponent(ref)}?recursive=1`)).tree || []).filter((t) => t.type === "blob").map((t) => t.path);
      const out = []; for (let page = 1; page <= 10; page++) { const r = await call("GET", `/projects/${id}/repository/tree?recursive=true&per_page=100&page=${page}&ref=${encodeURIComponent(ref)}`); out.push(...r.filter((t) => t.type === "blob").map((t) => t.path)); if (r.length < 100) break; } return out;
    },
    async readFile(p, ref) {
      if (gh) { const r = await call("GET", `/repos/${project}/contents/${p.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`); return unb64(r.content || ""); }
      const r = await call("GET", `/projects/${id}/repository/files/${encodeURIComponent(p)}?ref=${encodeURIComponent(ref)}`); return unb64(r.content || "");
    },
    /** New branch from base, the files committed on it, then a pull/merge request. Never touches the base branch. */
    async openPullRequest({ base, branch, title, body = "", files }) {
      if (!files || !files.length) throw new Error("No files to commit.");
      if (gh) {
        const sha = (await call("GET", `/repos/${project}/git/ref/heads/${encodeURIComponent(base)}`)).object.sha;
        await call("POST", `/repos/${project}/git/refs`, { ref: `refs/heads/${branch}`, sha });
        for (const f of files) await call("PUT", `/repos/${project}/contents/${f.path.split("/").map(encodeURIComponent).join("/")}`, { message: `Add AI-generated tests: ${f.path}`, content: b64(f.content), branch });
        const pr = await call("POST", `/repos/${project}/pulls`, { title, head: branch, base, body });
        return { url: pr.html_url, branch };
      }
      await call("POST", `/projects/${id}/repository/branches?branch=${encodeURIComponent(branch)}&ref=${encodeURIComponent(base)}`);
      await call("POST", `/projects/${id}/repository/commits`, { branch, commit_message: `Add AI-generated tests (${files.length} file${files.length > 1 ? "s" : ""})`, actions: files.map((f) => ({ action: "create", file_path: f.path, content: f.content })) });
      const mr = await call("POST", `/projects/${id}/merge_requests`, { source_branch: branch, target_branch: base, title, description: body });
      return { url: mr.web_url, branch };
    },
  };
  return api;
}
const fromEnv = ({ provider, project, baseUrl, env = process.env, fetchFn }) => connect({ provider, project, baseUrl, fetchFn, token: provider === "github" ? env.GITHUB_TOKEN : env.GITLAB_TOKEN });
module.exports = { connect, fromEnv };
