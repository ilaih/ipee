const https = require("https");
const http  = require("http");
const fs    = require("fs");
const path  = require("path");

const PORT = 3001;

const MIME = {
    ".html": "text/html",
    ".js":   "application/javascript",
    ".css":  "text/css",
    ".json": "application/json",
    ".png":  "image/png",
    ".jpg":  "image/jpeg",
    ".mp4":  "video/mp4",
};

// Ensure logs/ directory exists
const LOGS_DIR = path.join(__dirname, 'logs')
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR)

function handle(req, res) {
    // POST /log?session=<id>  — append CSV rows to logs/log_<id>.txt
    if (req.method === 'POST' && req.url.startsWith('/log')) {
        const session = new URL(req.url, 'http://x').searchParams.get('session') || 'unknown'
        const file    = path.join(LOGS_DIR, `log_${session}.txt`)
        let body = ''
        req.on('data', chunk => { body += chunk })
        req.on('end', () => {
            const header = 'timestamp,state,outerPx,innerPx,hitPx,exitPx,widthFiltered\n'
            const flag   = fs.existsSync(file) ? 'a' : 'w'
            fs.writeFile(file, flag === 'w' ? header + body : body, { flag }, () => {})
            res.writeHead(204); res.end()
        })
        return
    }

    const distDir  = path.join(__dirname, 'dist');
    const baseDir  = fs.existsSync(distDir) ? distDir : __dirname;
    let filePath = path.join(baseDir, req.url === "/" ? "/cam2.html" : req.url);
    const ext = path.extname(filePath);
    fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end("Not found"); return; }
        res.writeHead(200, { "Content-Type": MIME[ext] || "text/plain" });
        res.end(data);
    });
}

const certPath = "/etc/letsencrypt/live";
const domains  = fs.existsSync(certPath)
    ? fs.readdirSync(certPath).filter(d => !d.startsWith("README"))
    : [];
const domain = domains[0];

const localKey  = path.join(__dirname, "certs/key.pem");
const localCert = path.join(__dirname, "certs/cert.pem");

if (domain) {
    const opts = {
        key:  fs.readFileSync(`${certPath}/${domain}/privkey.pem`),
        cert: fs.readFileSync(`${certPath}/${domain}/fullchain.pem`),
    };
    https.createServer(opts, handle).listen(PORT, () =>
        console.log(`HTTPS on :${PORT}  (${domain}) → cam2.html`));
} else if (fs.existsSync(localKey) && fs.existsSync(localCert)) {
    const opts = { key: fs.readFileSync(localKey), cert: fs.readFileSync(localCert) };
    https.createServer(opts, handle).listen(PORT, () =>
        console.log(`HTTPS on :${PORT}  (self-signed cert) → cam2.html`));
} else {
    http.createServer(handle).listen(PORT, () =>
        console.log(`HTTP on :${PORT}  (no certs — camera requires localhost or HTTPS)`));
}
