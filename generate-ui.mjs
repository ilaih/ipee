// generate-ui.mjs — Generate ipee onboarding screens via Google Stitch SDK
import 'dotenv/config'
import { stitch } from '@google/stitch-sdk'
import { writeFileSync, mkdirSync } from 'fs'

const OUT = './stitch-ui'
mkdirSync(OUT, { recursive: true })

async function save(name, screen) {
    const url = await screen.getHtml()
    const file = `${OUT}/${name}.html`
    // getHtml() returns a signed download URL — fetch the actual content
    const urlStr = typeof url === 'string' ? url : String(url)
    const resp = await fetch(urlStr)
    if (!resp.ok) throw new Error(`Failed to fetch HTML for ${name}: ${resp.status}`)
    const content = await resp.text()
    writeFileSync(file, content)
    console.log(`✓ ${name} → ${file} (${content.length} bytes)`)
}

console.log('Creating Stitch project...')
const projects = await stitch.projects()
let project

const existing = projects.find(p => p.id === '13931110791102424150')
if (existing) {
    project = stitch.project(existing.id)
    console.log(`Using existing project: ${existing.id}`)
} else {
    project = await stitch.createProject('ipee-onboarding')
    console.log(`Created project: ${project.id}`)
}

// ── Screen 1: Age Gate ────────────────────────────────────────────────────────
console.log('\nGenerating age gate screen...')
const ageGate = await project.generate(
    `A mobile full-screen age verification page for a toilet aim game called "iPee".
    Dark background (#0d0d1a), futuristic neon style.
    Large toilet bowl emoji 🚽 at the top center.
    Bold white title: "iPee" with a neon blue glow.
    Subtitle: "Are you 18 or older?"
    Two large pill buttons side by side:
      - "YES, I AM 18+" in bright neon cyan/blue
      - "NO" in dark gray with subtle border
    Small disclaimer text at bottom: "This game is intended for adults only."
    No navigation bars. Mobile portrait layout 360×640.`,
    'MOBILE'
)
await save('age-gate', ageGate)

// ── Screen 2: Camera Loading ──────────────────────────────────────────────────
console.log('\nGenerating camera loading screen...')
const cameraLoad = await project.generate(
    `A mobile full-screen camera initializing/loading screen for a game called "iPee".
    Dark background (#0d0d1a), futuristic neon style.
    Center of screen: animated pulsing circle representing a camera lens, neon cyan color.
    Camera icon 📷 inside the pulsing circle.
    Text below: "Initializing Camera..." in white.
    Animated loading dots or spinner beneath the text, neon blue color.
    Bottom text: "Point your camera at the toilet bowl" in soft gray.
    No buttons. Mobile portrait layout 360×640.`,
    'MOBILE'
)
await save('camera-loading', cameraLoad)

// ── Screen 3: Level & Score HUD ───────────────────────────────────────────────
console.log('\nGenerating level/score screen...')
const levelScreen = await project.generate(
    `A mobile game HUD / stats screen for a toilet aim game called "iPee".
    Dark background (#0d0d1a), neon futuristic style.
    Top section: large "LEVEL 1" badge — hexagonal shape, neon gold/yellow glow, bold text.
    Below that: circular XP progress bar (0% filled) showing "0 / 100 XP".
    Middle section — score stats card with neon border:
      - "🎯 Best Streak" with value "0s"
      - "💦 Total Hits" with value "0"
      - "⭐ High Score" with value "0 pts"
    Bottom: large neon cyan button "PLAY NOW →".
    No navigation. Mobile portrait layout 360×640.`,
    'MOBILE'
)
await save('level-screen', levelScreen)

console.log('\n✅ All screens generated in ./stitch-ui/')
