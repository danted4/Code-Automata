#!/usr/bin/env node
/**
 * Generates the main app icon from the single source public/code-automata.png.
 * Outputs public/code-automata-dark.png at 1024x1024 (square, Mac-compliant).
 * If the source is not square, it is center-cropped first. No separate -512 file;
 * build-icons.js resizes from this for Windows/Linux.
 */

const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const cwd = path.resolve(__dirname, '..');
const publicDir = path.join(cwd, 'public');
const SOURCE = path.join(publicDir, 'code-automata.png');
const OUTPUT = path.join(publicDir, 'code-automata-dark.png');
const SIZE = 1024;

async function main() {
  if (!fs.existsSync(SOURCE)) {
    console.warn('Skipping: public/code-automata.png not found');
    return;
  }

  const meta = await sharp(SOURCE).metadata();
  const w = meta.width || 1;
  const h = meta.height || 1;
  const size = Math.min(w, h);
  const left = Math.floor((w - size) / 2);
  const top = Math.floor((h - size) / 2);

  await sharp(SOURCE)
    .extract({ left, top, width: size, height: size })
    .resize(SIZE, SIZE)
    .png()
    .toFile(OUTPUT);

  console.log('Created:', path.relative(cwd, OUTPUT));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
