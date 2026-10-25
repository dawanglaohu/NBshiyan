/**
 * Re-encode the company plate from the committed PNG.
 * WebP q80, smartSubsample, no withMetadata() — output must not carry author, software, path, GPS, or email.
 * Run: node scripts/export-company-plate.mjs
 * Check committed bytes: node scripts/export-company-plate.mjs --check
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const root = path.resolve(import.meta.dirname, '..');
const sourcePath = path.join(root, 'public/brand/company/company-introduction-v3-en.png');
const outDir = path.join(root, 'public/brand/company');
const check = process.argv.includes('--check');

const FULL_WIDTHS = [800, 1600, 2400];
const CROP = { left: 2490, top: 586, width: 2160, height: 1930 };
const COVER = { left: 1570, top: 1814, width: 590, height: 80 };
const CROP_SIZES = [
  { width: 480, height: 429 },
  { width: 960, height: 858 },
  { width: 1440, height: 1287 },
];

const webpOpts = { quality: 80, smartSubsample: true };

function asciiStrings(buffer, min = 8) {
  const found = [];
  let current = '';
  for (const byte of buffer) {
    if (byte >= 32 && byte <= 126) current += String.fromCharCode(byte);
    else {
      if (current.length >= min) found.push(current);
      current = '';
    }
  }
  if (current.length >= min) found.push(current);
  return found;
}

/** RIFF chunk ids plus readable strings a `strings` pass would treat as author, tool, path, GPS, or mail. */
function metadataHits(buffer) {
  const hits = [];
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') {
    hits.push('not a webp container');
  }
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === 'EXIF' || id === 'XMP ' || id === 'ICCP') hits.push(`chunk ${id}`);
    if (id === 'VP8X' && size >= 4) {
      const flags = buffer[offset + 8];
      if (flags & 0x20) hits.push('VP8X ICC');
      if (flags & 0x08) hits.push('VP8X EXIF');
      if (flags & 0x04) hits.push('VP8X XMP');
    }
    offset += 8 + size + (size & 1);
  }
  const readable = /exif|gps|adobe|photoshop|software|artist|copyright|libvips|\bsharp\b|@[a-z0-9.-]+\.[a-z]{2,}|[A-Za-z]:\\|\/Users\/|\/home\/|\.png/i;
  for (const text of asciiStrings(buffer)) {
    if (readable.test(text)) hits.push(text);
  }
  return hits;
}

async function encode(pipeline) {
  return pipeline.webp(webpOpts).toBuffer();
}

async function fullBuffers(source) {
  const out = [];
  for (const width of FULL_WIDTHS) {
    const buffer = await encode(sharp(source).resize({ width }));
    const meta = await sharp(buffer).metadata();
    const expectHeight = Math.round(width * 5800 / 5000);
    if (meta.width !== width || meta.height !== expectHeight) {
      throw new Error(`full ${width} is ${meta.width}x${meta.height}, expected ${width}x${expectHeight}`);
    }
    out.push({ stem: `company-introduction-v3-en-w${width}`, buffer, width: meta.width, height: meta.height });
  }
  return out;
}

async function cropBuffers(source) {
  const extracted = await sharp(source).extract(CROP).toBuffer();
  const covered = await sharp(extracted).composite([{
    input: { create: { width: COVER.width, height: COVER.height, channels: 3, background: '#fff' } },
    left: COVER.left,
    top: COVER.top,
  }]).toBuffer();
  const out = [];
  for (const size of CROP_SIZES) {
    const buffer = await encode(sharp(covered).resize(size.width, size.height, { fit: 'fill' }));
    const meta = await sharp(buffer).metadata();
    if (meta.width !== size.width || meta.height !== size.height) {
      throw new Error(`crop ${size.width} is ${meta.width}x${meta.height}`);
    }
    out.push({ stem: `company-introduction-v3-en-crop-${size.width}`, buffer, width: meta.width, height: meta.height });
  }
  return out;
}

function named(item) {
  const sha256 = createHash('sha256').update(item.buffer).digest('hex');
  const hash = sha256.slice(0, 8);
  const filename = `${item.stem}.${hash}.webp`;
  const hits = metadataHits(item.buffer);
  return { ...item, filename, hash, bytes: item.buffer.length, hits };
}

const source = await readFile(sourcePath);
const sourceMeta = await sharp(source).metadata();
if (sourceMeta.width !== 5000 || sourceMeta.height !== 5800) {
  throw new Error(`source is ${sourceMeta.width}x${sourceMeta.height}, expected 5000x5800`);
}

const items = [...await fullBuffers(source), ...await cropBuffers(source)].map(named);
const bad = items.filter((item) => item.hits.length > 0);
if (bad.length) {
  console.error(JSON.stringify(bad.map((item) => ({ filename: item.filename, hits: item.hits })), null, 2));
  throw new Error('webp contains metadata-like strings');
}

if (check) {
  for (const item of items) {
    const onDisk = await readFile(path.join(outDir, item.filename));
    if (!onDisk.equals(item.buffer)) throw new Error(`${item.filename} does not match a fresh encode`);
  }
} else {
  const keep = new Set(items.map((item) => item.filename));
  for (const name of await readdir(outDir)) {
    if (/^company-introduction-v3-en-(?:w\d+|crop-\d+)\.[0-9a-f]{8}\.webp$/.test(name) && !keep.has(name)) {
      await unlink(path.join(outDir, name));
    }
  }
  for (const item of items) await writeFile(path.join(outDir, item.filename), item.buffer);
}

console.log(JSON.stringify(items.map(({ filename, width, height, bytes, hash }) => ({ filename, width, height, bytes, hash })), null, 2));
