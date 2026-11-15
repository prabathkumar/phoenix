/**
 * Model for the agents = the TestOps GPU server (g4dn.xlarge, Tesla T4 16 GB) running Qwen3-8B under llama-server.
 * llama-server speaks the OpenAI chat API, so this is not Ollama. Config, not code:
 *   PHOENIX_AGENT_LLM_URL   e.g. http://<gpu-host>:8080   (falls back to TESTOPS_LLM_URL / OPENAI_BASE_URL)
 *   PHOENIX_AGENT_LLM_KEY   bearer key, once llama-server runs with --api-key (sent only if set)
 *   PHOENIX_AGENT_MODEL     default qwen3-8b
 * Sized for the T4: short prompts (<= ~2k chars), one request at a time (the box has 2 slots shared with TestOps), thinking off,
 * 90 s timeout because the Lambda-started instance can be cold. No URL set -> null, and the agents run on rules alone.
 */
function ollamaAsk(env = process.env) {
  const host = env.PHOENIX_AGENT_LLM_URL || env.TESTOPS_LLM_URL || env.OPENAI_BASE_URL;
  if (!host) return null;
  const base = (/^https?:/.test(host) ? host : `http://${host}`).replace(/\/(v1)?\/?$/, "");
  const model = env.PHOENIX_AGENT_MODEL || "qwen3-8b";
  return async (prompt) => {
    const headers = { "content-type": "application/json", ...(env.PHOENIX_AGENT_LLM_KEY ? { authorization: `Bearer ${env.PHOENIX_AGENT_LLM_KEY}` } : {}) };
    const body = { model, temperature: 0, max_tokens: 160, messages: [{ role: "user", content: `${String(prompt).slice(0, 2000)} /no_think` }] };
    const r = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(90000) });
    if (!r.ok) throw new Error(`llm ${r.status}`);
    const text = (await r.json()).choices?.[0]?.message?.content || "";
    return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  };
}
module.exports = { ollamaAsk };
