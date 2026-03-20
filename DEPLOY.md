# Deploy Guide

## Video privacy — already solved

The camera feed and simulation video **never leave the device**:

- `cam2.html` uses the browser's `getUserMedia()` API. The camera stream is processed entirely
  inside the phone's browser (drawn to a `<canvas>`). Nothing is uploaded to the server.
- `sim2.html` loads a local file via `<input type="file">`. The video is read by the browser
  locally. Nothing is uploaded.
- The only thing the server ever receives from the browser is `POST /log` — which contains
  only CSV numbers (timestamps and pixel counts, no image data).

---

## Local development (this machine)

No build step needed. The server detects that `dist/` does not exist and serves raw source
files directly.

```bash
node server2.js
```

Open `https://localhost:3001` or `http://localhost:3001` on this machine.
For `sim2.html`: open `http://localhost:3001/sim2.html`.

---

## EC2 deployment (public website)

### First-time setup

```bash
# 1. Clone / pull latest code to the server
git pull

# 2. Install all dependencies (including the obfuscator)
npm install

# 3. Build obfuscated assets into dist/
npm run build

# 4. Start the server
node server2.js
```

### After every code change

```bash
git pull
npm run build   # regenerates dist/ from updated source
# restart server (e.g. pm2 restart ipee, or systemctl restart ipee)
```

### What npm run build does

1. Reads each browser-side `.js` file (`shared2.js`, `tracker2.js`, etc.)
2. Runs `javascript-obfuscator` on it — renames all identifiers to hex strings,
   encodes string literals in base64. Output is still valid JavaScript.
3. Writes obfuscated files to `dist/` (same filenames).
4. Copies `cam2.html`, `sim2.html`, and `stitch-ui/` verbatim to `dist/`.

After the build, `server2.js` automatically detects `dist/` and serves from there.
The source files in the project root are never touched.

### HTTPS / certificates

`server2.js` looks for certificates in this order:

1. Let's Encrypt: `/etc/letsencrypt/live/<domain>/`
2. Self-signed: `certs/key.pem` + `certs/cert.pem`
3. Plain HTTP (fallback — camera will not work on non-localhost without HTTPS)

For a public site, use Let's Encrypt:

```bash
sudo certbot certonly --standalone -d yourdomain.com
# Then restart: node server2.js   (it will pick up the cert automatically)
```

### Keep server running (pm2)

```bash
npm install -g pm2
pm2 start server2.js --name ipee
pm2 save
pm2 startup   # follow the printed command to enable autostart on reboot
```
