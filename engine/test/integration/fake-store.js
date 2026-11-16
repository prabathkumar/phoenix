/**
 * A small local web store that behaves like the yes.my purchase journey, so the real engine (real Chromium, real page reading,
 * real goal loop, real agents) can be tested end to end without the internet or a live shop.
 *   /                      home: Devices menu (dropdown with Explore Devices), and a JOIN WAITLIST card for another product
 *   /devices               cards with "Buy now": Aurora X1 (1), Borealis X2 (2, sold out), Cirrus X3 (3, fails once), Delta X4 (4, ends in an error page)
 *   /add-to-cart/<id>      options: storage, New Line/Existing, payment plan, contract, tier; NEXT is disabled until a tier is chosen
 *   /checkout              "Order summary" (ok)         /checkout-error   "Something went wrong"
 */
const http = require("http");

function start() {
  const hits = { three: 0 };
  const page = (title, body, extra = "") => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>body{font-family:sans-serif;margin:24px}button,a.btn{padding:8px 12px;margin:4px;cursor:pointer}.card{border:1px solid #ccc;padding:12px;margin:8px;display:inline-block}[disabled]{opacity:.4}</style></head><body>${body}${extra}</body></html>`;
  const home = page("Home", `<nav><button id="devmenu" onclick="document.getElementById('dm').style.display='block'">Devices</button><div id="dm" style="display:none"><a href="/devices">Explore Devices</a></div></nav>
    <h1>Latest Devices</h1><div class="card"><h3>Echo X0</h3><span>JOIN WAITLIST</span></div>`);
  const devices = page("Devices", `<h1>Explore Devices</h1>
    ${[["Aurora X1", 1], ["Borealis X2", 2], ["Cirrus X3", 3], ["Delta X4", 4]].map(([n, i]) => `<div class="card"><h3>${n}</h3><a class="btn" href="/add-to-cart/${i}">Buy now</a></div>`).join("")}`);
  const product = (id) => {
    const name = { 1: "Aurora X1", 3: "Cirrus X3", 4: "Delta X4" }[id];
    const next = id === 4 ? "/checkout-error" : "/checkout";
    return page(name, `<h1>${name}</h1><p>In Stock</p>
    <h3>Select Storage</h3><button class="opt">128GB</button><button class="opt">256GB</button>
    <h3>Choose An Action</h3><button class="opt">New Line</button><button class="opt">Existing</button>
    <h3>Choose Preferred Payment Plan</h3><button class="opt" onclick="plan('inf')">Infinite+</button><button class="opt" onclick="plan('cash')">Infinite Cashback</button>
    <div id="contract" style="display:none"><h3>Choose Contract Period</h3><span id="c-inf"><button class="opt" onclick="contract()">24 Months</button><button class="opt" onclick="contract()">36 Months</button></span><span id="c-cash"><button class="opt" onclick="contract()">No Contract</button></span></div>
    <div id="tiers" style="display:none"><h3>Select A Postpaid Plan</h3><span id="t-inf"><button class="opt" onclick="tier()">Infinite+ Ultra</button><button class="opt" onclick="tier()">Infinite+ Basic</button></span><span id="t-cash"><button class="opt" onclick="tier()">Infinite Cashback Standard</button></span></div>
    <hr><button id="btn-add-to-cart" disabled onclick="location.href='${next}'">NEXT</button>`,
    `<script>function plan(p){document.getElementById('contract').style.display='block';document.getElementById('c-inf').style.display=p==='inf'?'inline':'none';document.getElementById('c-cash').style.display=p==='cash'?'inline':'none';window.P=p}
    function contract(){document.getElementById('tiers').style.display='block';document.getElementById('t-inf').style.display=window.P==='inf'?'inline':'none';document.getElementById('t-cash').style.display=window.P==='cash'?'inline':'none'}
    function tier(){document.getElementById('btn-add-to-cart').disabled=false}</script>`);
  };
  const server = http.createServer((req, res) => {
    const u = req.url.split("?")[0];
    const send = (body, code = 200) => { res.writeHead(code, { "Content-Type": "text/html; charset=utf-8", "Set-Cookie": "sid=abc; Path=/" }); res.end(body); };
    if (u === "/") return send(home);
    if (u === "/devices") return send(devices);
    if (u === "/add-to-cart/2") return send(page("Borealis X2", `<h1>Borealis X2</h1><p>Sold out online. Visit your nearest Store.</p>`));
    if (u === "/add-to-cart/3") { hits.three += 1; return send(hits.three === 1 ? page("Oops", `<h1>Cirrus X3</h1><p>Something went wrong. Please try again.</p>`) : product(3)); }
    const m = /^\/add-to-cart\/([14])$/.exec(u); if (m) return send(product(Number(m[1])));
    if (u === "/checkout") return send(page("Checkout", `<h1>Order summary</h1><p>Your details</p>`));
    if (u === "/checkout-error") return send(page("Checkout", `<h1>Checkout</h1><p>Something went wrong. Please try again later.</p>`));
    send(page("Not found", "<h1>Page not found</h1>"), 404);
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok({ url: `http://127.0.0.1:${server.address().port}`, hits, close: () => new Promise((d) => server.close(d)) })));
}
module.exports = { start };
