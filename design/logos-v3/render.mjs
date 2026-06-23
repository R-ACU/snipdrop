import sharp from "sharp";
import { readFileSync, writeFileSync } from "node:fs";

const logos = ["A-drop-scene", "B-app-badge", "C-snip-mark"];
const sizes = [256, 128, 64, 32, 16];

// individual PNGs
for (const name of logos) {
  const svg = readFileSync(`${name}.svg`);
  for (const s of sizes) {
    await sharp(svg, { density: 384 })
      .resize(s, s, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toFile(`render/${name}-${s}.png`);
  }
}

// contact sheet on light + dark, showing each logo at a few sizes
const cell = 150;
const cols = 5; // label + 256 + 64 + 32 + 16
const labels = { "A-drop-scene": "A · Drop Scene", "B-app-badge": "B · App Badge", "C-snip-mark": "C · Snip Mark" };
const showSizes = [128, 64, 32, 16];

async function sheet(bg, fg, file) {
  const W = cols * cell;
  const H = logos.length * cell + 40;
  const composites = [];
  // header
  const headerParts = showSizes.map((s, i) =>
    `<text x="${(i + 1) * cell + cell / 2}" y="26" font-family="Segoe UI, sans-serif" font-size="18" fill="${fg}" text-anchor="middle">${s}px</text>`
  ).join("");
  let y = 40;
  for (const name of logos) {
    const svg = readFileSync(`${name}.svg`);
    // label
    composites.push({
      input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${cell}" height="${cell}"><text x="16" y="${cell / 2}" font-family="Segoe UI, sans-serif" font-size="20" font-weight="600" fill="${fg}">${labels[name]}</text></svg>`),
      left: 0, top: y,
    });
    let x = cell;
    for (const s of showSizes) {
      const png = await sharp(svg, { density: 384 })
        .resize(s, s, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png().toBuffer();
      composites.push({ input: png, left: x + Math.round((cell - s) / 2), top: y + Math.round((cell - s) / 2) });
      x += cell;
    }
    y += cell;
  }
  const header = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="40">${headerParts}</svg>`);
  composites.unshift({ input: header, left: 0, top: 0 });
  await sharp({ create: { width: W, height: H, channels: 4, background: bg } })
    .composite(composites).png().toFile(file);
}

await sheet({ r: 248, g: 250, b: 252, alpha: 1 }, "#0f172a", "render/_sheet-light.png");
await sheet({ r: 17, g: 24, b: 39, alpha: 1 }, "#f8fafc", "render/_sheet-dark.png");

console.log("done");
