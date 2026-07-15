const http = require("http");
const fs = require("fs");
const path = require("path");
const PORT = process.env.PORT || 18930;
const DATA_FILE = path.join(__dirname, "data.json");

let store = { checks: {}, names: {}, colors: {}, customTasks: [] };
function load() { try { if (fs.existsSync(DATA_FILE)) store = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8")); } catch(e) {} }
function save() { try { fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2), "utf-8"); } catch(e) {} }
load();

http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  try {
    var u = new URL(req.url, "http://localhost");
    
    if (u.pathname === "/api/data" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(store));
    }
    
    if (u.pathname === "/api/save" && req.method === "POST") {
      var body = "";
      req.on("data", c => body += c);
      req.on("end", () => {
        try {
          var d = JSON.parse(body);
          Object.keys(d).forEach(k => { if (k in store) store[k] = d[k]; });
          save();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch(e) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found: " + u.pathname);
  } catch(e) {
    res.writeHead(500);
    res.end("Server Error");
  }
}).listen(PORT, "0.0.0.0", () => {
  console.log("Sync server running on port " + PORT);
});
