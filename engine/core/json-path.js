/**
 * Tiny JSON path reader for API checks: `$.a.b[0].c`, `a.b`, `items[2]`, or
 * `$` for the whole body. No wildcards or filters on purpose - a check should
 * point at exactly one value.
 * @returns {{found: boolean, value?: any}}
 */
function readPath(root, path) {
  let p = String(path || "").trim();
  if (p === "" || p === "$") return { found: true, value: root };
  if (p.startsWith("$")) p = p.slice(1);
  if (p.startsWith(".")) p = p.slice(1);
  const tokens = [];
  const re = /([^.[\]]+)|\[(\d+)\]/g;
  let m;
  while ((m = re.exec(p))) tokens.push(m[1] !== undefined ? m[1] : Number(m[2]));
  let cur = root;
  for (const t of tokens) {
    if (cur === null || cur === undefined || typeof cur !== "object" || !(t in Object(cur))) return { found: false };
    cur = cur[t];
  }
  return { found: true, value: cur };
}

module.exports = { readPath };
