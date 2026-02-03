#!/usr/bin/env node
/**
 * Builds dock icons (macOS-style rounded corners) from the single app icon.
 * Reads public/code-automata-dark.png and writes code-automata-dock.png and
 * code-automata-dock-light.png (same content; no light/dark variant).
 * - Rounded corners ~22% radius
 * - Zoomed content (1.25x) to reduce wasted space
 */

const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const INPUT = 'code-automata-dark.png';
const OUTPUTS = ['code-automata-dock.png', 'code-automata-dock-light.png'];
const ZOOM = 1.25;
const CORNER_RADIUS_PCT = 0.22;

async function buildDockIcons() {
  const inputPath = path.resolve(__dirname, '..', 'public', INPUT);
  if (!fs.existsSync(inputPath)) {
    console.warn('Skipping (not found):', INPUT);
    return;
  }

  const meta = await sharp(inputPath).metadata();
  const size = meta.width || 1024;
  const radius = Math.round(size * CORNER_RADIUS_PCT);

  const zoomedSize = Math.round(size * ZOOM);
  const left = Math.floor((zoomedSize - size) / 2);
  const top = left;

  const zoomed = await sharp(inputPath)
    .resize(zoomedSize, zoomedSize)
    .extract({ left, top, width: size, height: size })
    .toBuffer();

  const maskSvg = `
    <svg width="${size}" height="${size}">
      <rect x="0" y="0" width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="white"/>
    </svg>
  `;

  const rounded = await sharp(zoomed)
    .composite([{ input: Buffer.from(maskSvg), blend: 'dest-in' }])
    .png()
    .toBuffer();

  const publicDir = path.resolve(__dirname, '..', 'public');
  for (const outName of OUTPUTS) {
    await sharp(rounded).toFile(path.join(publicDir, outName));
    console.log('Built:', outName);
  }
}

buildDockIcons().catch((err) => {
  console.error(err);
  process.exit(1);
});
