// Build script — run on the server before deploying.
// Obfuscates browser-side JS files and copies HTML assets to dist/.
// Usage: node build.js
//
// Requires: npm install --save-dev javascript-obfuscator

const fs   = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');

// Browser-side JS files to obfuscate (server*.js excluded — they run on Node, not browser)
const JS_FILES = [
    'shared2.js',
    'settings2.js',
    'calib2.js',
    'levels2.js',
    'tracker2.js',
    'stream2.js',
    'water2.js',
    'onboarding.js',
];

// HTML files / directories to copy verbatim (no obfuscation needed for HTML)
const HTML_FILES = [
    'cam2.html',
    'sim2.html',
];

const OBFUSCATOR_OPTIONS = {
    compact: true,
    controlFlowFlattening: false,
    deadCodeInjection: false,
    stringArray: false,             // keep off — string array lookups add function-call overhead
                                    // that breaks JIT optimisation in tight NCC loops
    identifierNamesGenerator: 'hexadecimal',
    renameGlobals: false,           // keep off — globals like W, H, ZOOM are shared across files
    selfDefending: false,
};

function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function copyDir(src, dest) {
    ensureDir(dest);
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, entry.name);
        const d = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            copyDir(s, d);
        } else {
            fs.copyFileSync(s, d);
        }
    }
}

ensureDir(DIST);

// Obfuscate JS files
for (const file of JS_FILES) {
    const srcPath = path.join(ROOT, file);
    if (!fs.existsSync(srcPath)) {
        console.warn(`SKIP (not found): ${file}`);
        continue;
    }
    const src = fs.readFileSync(srcPath, 'utf8');
    const result = JavaScriptObfuscator.obfuscate(src, OBFUSCATOR_OPTIONS);
    fs.writeFileSync(path.join(DIST, file), result.getObfuscatedCode(), 'utf8');
    console.log(`Obfuscated: ${file}`);
}

// Copy HTML files verbatim
for (const file of HTML_FILES) {
    const srcPath = path.join(ROOT, file);
    if (!fs.existsSync(srcPath)) {
        console.warn(`SKIP (not found): ${file}`);
        continue;
    }
    fs.copyFileSync(srcPath, path.join(DIST, file));
    console.log(`Copied:     ${file}`);
}

// Copy stitch-ui/ directory verbatim
const stitchSrc  = path.join(ROOT, 'stitch-ui');
const stitchDest = path.join(DIST, 'stitch-ui');
if (fs.existsSync(stitchSrc)) {
    copyDir(stitchSrc, stitchDest);
    console.log('Copied:     stitch-ui/');
}

console.log(`\nBuild complete → dist/`);
