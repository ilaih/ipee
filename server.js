const https = require("https");
const http  = require("http");
const fs    = require("fs");
const path  = require("path");

const PORT_HTTP  = 80;
const PORT_HTTPS = 443;

const MIME = {
    ".html": "text/html",
    ".js":   "application/javascript",
    ".css":  "text/css",
    ".json": "application/json",
    ".png":  "image/png",
    ".jpg":  "image/jpeg",
    ".mp4":  "video/mp4",
};

function handle(req, res) {
    let filePath = path.join(__dirname, req.url === "/" ? "/game.html" : req.url);
    const ext = path.extname(filePath);
    fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end("Not found"); return; }
        res.writeHead(200, { "Content-Type": MIME[ext] || "text/plain" });
        res.end(data);
    });
}

// HTTP → redirect to HTTPS (if certs exist), or serve directly
const certPath  = "/etc/letsencrypt/live";
const domains   = fs.existsSync(certPath) ? fs.readdirSync(certPath).filter(d => !d.startsWith("README")) : [];
const domain    = domains[0];

if (domain) {
    const opts = {
        key:  fs.readFileSync(`${certPath}/${domain}/privkey.pem`),
        cert: fs.readFileSync(`${certPath}/${domain}/fullchain.pem`),
    };
    https.createServer(opts, handle).listen(PORT_HTTPS, () =>
        console.log(`HTTPS on :${PORT_HTTPS}  (${domain})`));
    // Redirect HTTP → HTTPS
    http.createServer((req, res) => {
        res.writeHead(301, { Location: `https://${req.headers.host}${req.url}` });
        res.end();
    }).listen(PORT_HTTP, () => console.log(`HTTP redirect on :${PORT_HTTP}`));
} else {
    // No certs — plain HTTP (getUserMedia will only work if accessed via localhost)
    const PORT = 3000;
    http.createServer(handle).listen(PORT, () =>
        console.log(`HTTP on :${PORT}  (no certs found — HTTPS not available)`));
}
