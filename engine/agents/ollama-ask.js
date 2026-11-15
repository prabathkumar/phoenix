/** Local model for the agents (the GPU server's Ollama). Model/host are config, not code: PHOENIX_AGENT_MODEL (default llama3), TESTOPS_OLLAMA_URL | OLLAMA_URL | OLLAMA_HOST. Returns null when no host is set, so agents run on rules alone. */
function ollamaAsk(env = process.env) {
  const host = env.TESTOPS_OLLAMA_URL || env.OLLAMA_URL || env.OLLAMA_HOST;
  if (!host) return null;
  const base = /^https?:/.test(host) ? host.replace(/\/$/, "") : `http://${host}`;
  const model = env.PHOENIX_AGENT_MODEL || env.DEEPEVAL_OLLAMA_MODEL || "llama3";
  return async (prompt) => {
    const r = await fetch(`${base}/api/generate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, prompt, stream: false, options: { temperature: 0 } }), signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error(`ollama ${r.status}`);
    return (await r.json()).response || "";
  };
}
module.exports = { ollamaAsk };
