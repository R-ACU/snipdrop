// Renders 3 NSIS installer sidebar variants (164x314) + matching headers (150x57)
// as preview PNGs. Run from design/logos-v3 so `sharp` resolves.
//   node ../installer/build-previews.mjs
import sharp from "../logos-v3/node_modules/sharp/dist/index.cjs";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "previews");
mkdirSync(out, { recursive: true });

const SCALE = 3; // render crisp, keep exact-size copies too

// ---- shared brand fragments -------------------------------------------------

// app-badge mark (image card + green peaks + >_ prompt), parameterised size/pos
function badge(x, y, s) {
  const u = (n) => (n * s).toFixed(2);
  return `
  <g transform="translate(${x} ${y})">
    <rect x="${u(20)}" y="${u(20)}" width="${u(216)}" height="${u(216)}" rx="${u(50)}" fill="url(#badge)"/>
    <rect x="${u(60)}" y="${u(50)}" width="${u(136)}" height="${u(92)}" rx="${u(14)}" fill="#f8fafc"/>
    <circle cx="${u(92)}" cy="${u(80)}" r="${u(11)}" fill="#22d3ee"/>
    <path d="M${u(74)} ${u(126)} L${u(104)} ${u(90)} L${u(122)} ${u(110)} L${u(150)} ${u(78)} L${u(182)} ${u(124)}"
          fill="none" stroke="#90ff4f" stroke-width="${u(10)}" stroke-linecap="round" stroke-linejoin="round"/>
    <g fill="none" stroke="#f8fafc" stroke-linecap="round" stroke-linejoin="round">
      <path d="M${u(64)} ${u(168)} L${u(84)} ${u(184)} L${u(64)} ${u(200)}" stroke-width="${u(12)}"/>
      <path d="M${u(100)} ${u(200)} H${u(160)}" stroke-width="${u(12)}"/>
    </g>
  </g>`;
}

// drop-scene mark (tile -> prompt zone), parameterised
function dropScene(x, y, s) {
  const u = (n) => (n * s).toFixed(2);
  return `
  <g transform="translate(${x} ${y}) scale(${s})" fill="none" stroke-linecap="round" stroke-linejoin="round">
    <g transform="translate(40 24) rotate(-7 52 40)">
      <rect x="0" y="0" width="104" height="82" rx="12" stroke="#64748b" stroke-width="6" stroke-dasharray="15 9"/>
      <circle cx="28" cy="27" r="11" fill="#22d3ee"/>
      <path d="M12 64 L38 32 L55 51 L78 25 L96 58" stroke="#90ff4f" stroke-width="7"/>
    </g>
    <path d="M150 118 C188 130 200 142 200 158" stroke="#94a3b8" stroke-width="6" stroke-dasharray="3 12"/>
    <path d="M188 150 L200 162 L212 150" stroke="#94a3b8" stroke-width="6"/>
    <g transform="translate(140 96)">
      <path d="M0 0 L0 30 L8 22 L14 33 L19 31 L13 20 L23 20 Z" fill="#0f172a" stroke="#f8fafc" stroke-width="3.5"/>
    </g>
    <rect x="34" y="166" width="188" height="62" rx="20" stroke="#2f6fff" stroke-width="7" stroke-dasharray="17 12"/>
    <path d="M58 184 L76 197 L58 210" stroke="#90ff4f" stroke-width="8"/>
    <path d="M94 204 H196" stroke="#64748b" stroke-width="6" stroke-dasharray="13 12"/>
  </g>`;
}

const FONT = `'Segoe UI', 'Helvetica Neue', Arial, sans-serif`;
const MONO = `'Cascadia Code', 'Consolas', 'JetBrains Mono', ui-monospace, monospace`;

// ---- variant 1: weiss-minimal (Apple-Stil) ----------------------------------
function v1_sidebar(W, H) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 164 314">
    <defs>
      <linearGradient id="badge" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#3b82f6"/><stop offset="0.55" stop-color="#2f6fff"/><stop offset="1" stop-color="#1e49d4"/>
      </linearGradient>
      <linearGradient id="bg1" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#f4f7fb"/>
      </linearGradient>
    </defs>
    <rect width="164" height="314" fill="url(#bg1)"/>
    <rect x="0" y="0" width="164" height="4" fill="#2f6fff"/>
    ${badge(40, 54, 0.36)}
    <text x="82" y="208" text-anchor="middle" font-family="${FONT}" font-size="26" font-weight="700" fill="#0f172a">SnipDrop</text>
    <text x="82" y="230" text-anchor="middle" font-family="${FONT}" font-size="10.5" font-weight="500" fill="#64748b">Screenshot. Paste anywhere.</text>
    <line x1="52" y1="252" x2="112" y2="252" stroke="#e2e8f0" stroke-width="2"/>
    <text x="82" y="298" text-anchor="middle" font-family="${MONO}" font-size="9" fill="#94a3b8">v0.1.0 · Windows</text>
  </svg>`;
}
function v1_header(W, H) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 150 57">
    <defs><linearGradient id="badge" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#3b82f6"/><stop offset="0.55" stop-color="#2f6fff"/><stop offset="1" stop-color="#1e49d4"/>
    </linearGradient></defs>
    <rect width="150" height="57" fill="#ffffff"/>
    ${badge(6, -3, 0.27)}
    <text x="66" y="34" font-family="${FONT}" font-size="17" font-weight="700" fill="#0f172a">SnipDrop</text>
  </svg>`;
}

// ---- variant 2: dunkel / CMD-Aesthetik --------------------------------------
function v2_sidebar(W, H) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 164 314">
    <defs>
      <linearGradient id="badge" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#3b82f6"/><stop offset="0.55" stop-color="#2f6fff"/><stop offset="1" stop-color="#1e49d4"/>
      </linearGradient>
      <radialGradient id="bg2" cx="0.5" cy="0.32" r="0.9">
        <stop offset="0" stop-color="#16203a"/><stop offset="1" stop-color="#0a0f1e"/>
      </radialGradient>
    </defs>
    <rect width="164" height="314" fill="url(#bg2)"/>
    <g opacity="0.06" stroke="#90ff4f" stroke-width="1">
      ${Array.from({ length: 12 }, (_, i) => `<line x1="0" y1="${i * 26 + 8}" x2="164" y2="${i * 26 + 8}"/>`).join("")}
    </g>
    ${badge(40, 40, 0.36)}
    <text x="82" y="196" text-anchor="middle" font-family="${MONO}" font-size="25" font-weight="700" fill="#f8fafc">SnipDrop</text>
    <g font-family="${MONO}" font-size="10.5">
      <text x="24" y="232" fill="#90ff4f">&gt;</text>
      <text x="36" y="232" fill="#cbd5e1">install snipdrop</text>
    </g>
    <g font-family="${MONO}" font-size="10.5">
      <text x="24" y="252" fill="#90ff4f">&gt;</text>
      <text x="36" y="252" fill="#64748b">snip · paste · drop</text>
      <rect x="150" y="244" width="7" height="11" fill="#90ff4f"/>
    </g>
    <text x="82" y="298" text-anchor="middle" font-family="${MONO}" font-size="9" fill="#475569">v0.1.0 · Windows</text>
  </svg>`;
}
function v2_header(W, H) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 150 57">
    <defs><linearGradient id="badge" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#3b82f6"/><stop offset="0.55" stop-color="#2f6fff"/><stop offset="1" stop-color="#1e49d4"/>
    </linearGradient></defs>
    <rect width="150" height="57" fill="#0a0f1e"/>
    ${badge(6, -3, 0.27)}
    <text x="64" y="28" font-family="${MONO}" font-size="15" font-weight="700" fill="#f8fafc">SnipDrop</text>
    <text x="64" y="43" font-family="${MONO}" font-size="9" fill="#90ff4f">&gt; ready_</text>
  </svg>`;
}

// ---- variant 3: ASCII / Drop-Szene ------------------------------------------
function v3_sidebar(W, H) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 164 314">
    <defs>
      <linearGradient id="bg3" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#eef4ff"/><stop offset="1" stop-color="#ffffff"/>
      </linearGradient>
    </defs>
    <rect width="164" height="314" fill="url(#bg3)"/>
    <rect x="0" y="0" width="164" height="4" fill="#2f6fff"/>
    ${dropScene(14, 30, 0.52)}
    <text x="82" y="232" text-anchor="middle" font-family="${FONT}" font-size="25" font-weight="700" fill="#0f172a">SnipDrop</text>
    <text x="82" y="253" text-anchor="middle" font-family="${FONT}" font-size="10.5" font-weight="500" fill="#475569">Drop it where you need it.</text>
    <text x="82" y="298" text-anchor="middle" font-family="${MONO}" font-size="9" fill="#94a3b8">v0.1.0 · Windows</text>
  </svg>`;
}
function v3_header(W, H) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 150 57">
    <rect width="150" height="57" fill="#ffffff"/>
    ${dropScene(-12, -8, 0.28)}
    <text x="64" y="34" font-family="${FONT}" font-size="17" font-weight="700" fill="#0f172a">SnipDrop</text>
  </svg>`;
}

// ---- FINAL: weiss-minimal layout (v1) + ASCII drop-scene mark ---------------
function vf_sidebar(W, H) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 164 314">
    <defs>
      <linearGradient id="bg1" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#f4f7fb"/>
      </linearGradient>
    </defs>
    <rect width="164" height="314" fill="url(#bg1)"/>
    <rect x="0" y="0" width="164" height="4" fill="#2f6fff"/>
    ${dropScene(14, 22, 0.5)}
    <text x="82" y="212" text-anchor="middle" font-family="${FONT}" font-size="26" font-weight="700" fill="#0f172a">SnipDrop</text>
    <text x="82" y="234" text-anchor="middle" font-family="${FONT}" font-size="10.5" font-weight="500" fill="#64748b">Screenshot. Paste anywhere.</text>
    <line x1="52" y1="256" x2="112" y2="256" stroke="#e2e8f0" stroke-width="2"/>
    <text x="82" y="300" text-anchor="middle" font-family="${MONO}" font-size="9" fill="#94a3b8">v0.1.0 · Windows</text>
  </svg>`;
}
function vf_header(W, H) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 150 57">
    <rect width="150" height="57" fill="#ffffff"/>
    ${dropScene(-12, -8, 0.28)}
    <text x="64" y="34" font-family="${FONT}" font-size="17" font-weight="700" fill="#0f172a">SnipDrop</text>
  </svg>`;
}

const variants = [
  { id: "v1-weiss-minimal", sb: v1_sidebar, hd: v1_header },
  { id: "v2-dunkel-cmd", sb: v2_sidebar, hd: v2_header },
  { id: "v3-ascii-drop", sb: v3_sidebar, hd: v3_header },
  { id: "final-weiss-ascii", sb: vf_sidebar, hd: vf_header },
];

async function svgToPng(svg, file) {
  await sharp(Buffer.from(svg)).png().toFile(join(out, file));
}

for (const v of variants) {
  // exact-size (what NSIS uses) + 3x preview
  await svgToPng(v.sb(164, 314), `${v.id}-sidebar.png`);
  await svgToPng(v.sb(164 * SCALE, 314 * SCALE), `${v.id}-sidebar@3x.png`);
  await svgToPng(v.hd(150, 57), `${v.id}-header.png`);
  await svgToPng(v.hd(150 * SCALE, 57 * SCALE), `${v.id}-header@3x.png`);
}

// comparison sheet: 3 sidebars (3x) side by side on grey
const SW = 164 * SCALE, SH = 314 * SCALE, GAP = 60, PAD = 60;
const sheetW = PAD * 2 + SW * 3 + GAP * 2;
const sheetH = PAD * 2 + SH + 80;
const labels = ["1 · weiss-minimal", "2 · dunkel / CMD", "3 · ASCII-drop"];
const labelSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${sheetW}" height="${sheetH}">
  <rect width="${sheetW}" height="${sheetH}" fill="#3a3f4b"/>
  ${labels.map((l, i) => `<text x="${PAD + i * (SW + GAP) + SW / 2}" y="${PAD + SH + 50}" text-anchor="middle" font-family="${FONT}" font-size="34" font-weight="600" fill="#f1f5f9">${l}</text>`).join("")}
</svg>`;
const composites = variants.map((v, i) => ({
  input: join(out, `${v.id}-sidebar@3x.png`),
  left: PAD + i * (SW + GAP),
  top: PAD,
}));
await sharp(Buffer.from(labelSvg)).composite(composites).png().toFile(join(out, "_compare-sheet.png"));

console.log("done ->", out);
