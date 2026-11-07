#!/usr/bin/env node
'use strict';

/*
 * make_icon.js
 * ------------
 * Renders `media/toolkit.png` (256x256, 8-bit RGBA, non-interlaced) from the
 * line-art flask glyph in `media/toolkit.svg`, so that the extension icon
 * satisfies the VS Code Marketplace rule "PNG, at least 128x128 (256x256
 * recommended), never an SVG".
 *
 * No third-party dependencies and no network access: the PNG encoder
 * (signature / IHDR / single IDAT / IEND + CRC32 per chunk) is written here on
 * top of node:zlib only. Output is byte-reproducible (no tIME chunk, fixed
 * deflate level, deterministic raster maths).
 *
 * Usage (from the `extension/` directory):
 *   node scripts/make_icon.js             # render + verify, print JSON summary
 *   node scripts/make_icon.js --verify    # re-read the PNG and verify it only
 *   node scripts/make_icon.js --verbose   # also print the verification report
 *
 * Exit status is non-zero if any verification check fails.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const EXT_ROOT = path.resolve(__dirname, '..');
const SVG_PATH = path.join(EXT_ROOT, 'media', 'toolkit.svg');
const PNG_PATH = path.join(EXT_ROOT, 'media', 'toolkit.png');

/* ---------------------------------------------------------------- canvas --- */

const WIDTH = 256;
const HEIGHT = 256;
const BIT_DEPTH = 8;
const COLOR_TYPE = 6; // 8-bit RGBA
const SUPERSAMPLE = 4; // 4x4 samples per pixel -> anti-aliasing
const AA_BAND = 1.0; // soft edge width, in device pixels
const GLYPH_FILL = 0.70; // glyph stays inside the central ~70% of the canvas
const CORNER_RADIUS = 40; // rounded-square background corner radius, device px

const BG_TOP = [0x16, 0x41, 0x4e]; // deep slate/teal (#12343F family)
const BG_BOTTOM = [0x0e, 0x2a, 0x33];
const GLASS_TINT = [0x2a, 0x5c, 0x69]; // faint tint for the empty glass above the liquid
const GLASS_TINT_ALPHA = 0.30;
const LIQUID_TOP = [0xd6, 0xae, 0x35]; // warm accent, #C9A227 family
const LIQUID_BOTTOM = [0xb0, 0x8b, 0x21];
const STROKE_RGB = [0xe8, 0xe8, 0xe8]; // flask line-art colour
const LIQUID_SURFACE_VB = 14; // viewBox y of the "M8 14h8" liquid level line

/* ------------------------------------------------------------- utilities --- */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ------------------------------------------------- SVG path mini-parser --- */

function tokenizePath(d) {
  const tokens = [];
  let i = 0;
  while (i < d.length) {
    const ch = d[i];
    if (/\s|,/.test(ch)) {
      i++;
      continue;
    }
    if (/[A-Za-z]/.test(ch)) {
      tokens.push({ type: 'cmd', value: ch });
      i++;
      continue;
    }
    const m = /^[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/.exec(d.slice(i));
    if (!m) throw new Error(`cannot parse path data near offset ${i}: "${d}"`);
    tokens.push({ type: 'num', value: parseFloat(m[0]) });
    i += m[0].length;
  }
  return tokens;
}

/**
 * Flatten an SVG elliptical arc (endpoint parameterisation, spec F.6) into a
 * polyline. rx === ry and rotation 0 is all this icon needs, but the general
 * form is implemented so the geometry is reproduced exactly rather than
 * eyeballed.
 */
function arcPolyline(x1, y1, rel, rx, ry, rotDeg, largeArc, sweep, xRaw, yRaw) {
  const x2 = rel ? x1 + xRaw : xRaw;
  const y2 = rel ? y1 + yRaw : yRaw;
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  if (rx === 0 || ry === 0) return [{ x: x2, y: y2 }];
  if (x1 === x2 && y1 === y2) return [];

  const phi = (rotDeg * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cosPhi * dx + sinPhi * dy;
  const y1p = -sinPhi * dx + cosPhi * dy;

  let rx2 = rx * rx;
  let ry2 = ry * ry;
  const lambda = x1p * x1p / rx2 + y1p * y1p / ry2;
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s; ry *= s; rx2 = rx * rx; ry2 = ry * ry;
  }

  const sign = largeArc === sweep ? -1 : 1;
  const num = rx2 * ry2 - rx2 * y1p * y1p - ry2 * x1p * x1p;
  const den = rx2 * y1p * y1p + ry2 * x1p * x1p;
  const factor = sign * Math.sqrt(Math.max(0, num / den));
  const cxp = factor * (rx * y1p / ry);
  const cyp = factor * (-(ry * x1p / rx));
  const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2;

  const theta1 = Math.atan2((y1p - cyp) / ry, (x1p - cxp) / rx);
  const theta2 = Math.atan2((-y1p - cyp) / ry, (-x1p - cxp) / rx);
  let dTheta = theta2 - theta1;
  while (dTheta > Math.PI) dTheta -= 2 * Math.PI;
  while (dTheta < -Math.PI) dTheta += 2 * Math.PI;
  if (sweep === 0 && dTheta > 0) dTheta -= 2 * Math.PI;
  if (sweep === 1 && dTheta < 0) dTheta += 2 * Math.PI;

  const steps = Math.max(2, Math.ceil(Math.abs(dTheta) / (Math.PI / 18))); // <= 10 deg per step
  const pts = [];
  for (let s = 1; s <= steps; s++) {
    const th = theta1 + dTheta * (s / steps);
    const c = Math.cos(th);
    const s2 = Math.sin(th);
    pts.push({ x: cosPhi * rx * c - sinPhi * ry * s2 + cx, y: sinPhi * rx * c + cosPhi * ry * s2 + cy });
  }
  pts[pts.length - 1] = { x: x2, y: y2 }; // land exactly on the endpoint
  return pts;
}

/** Parse SVG path data into polylines (arcs flattened, no implicit close). */
function parsePath(d) {
  const tokens = tokenizePath(d);
  const subpaths = [];
  let cur = null;
  let cx = 0;
  let cy = 0;
  let cmd = null;
  let i = 0;

  const num = () => {
    if (i >= tokens.length || tokens[i].type !== 'num') throw new Error(`expected a number in path "${d}"`);
    return tokens[i++].value;
  };

  while (i < tokens.length) {
    if (tokens[i].type === 'cmd') cmd = tokens[i++].value;
    if (!cmd) throw new Error(`path data before a command: "${d}"`);
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();

    if (C === 'M') {
      const x = num();
      const y = num();
      cx = rel ? cx + x : x;
      cy = rel ? cy + y : y;
      cur = [{ x: cx, y: cy }];
      subpaths.push(cur);
      cmd = rel ? 'm' : 'l'; // implicit lineto after a moveto
      continue;
    }
    if (!cur) throw new Error(`command ${cmd} before any moveto: "${d}"`);

    if (C === 'L') {
      const x = num();
      const y = num();
      cx = rel ? cx + x : x;
      cy = rel ? cy + y : y;
      cur.push({ x: cx, y: cy });
    } else if (C === 'H') {
      const x = num();
      cx = rel ? cx + x : x;
      cur.push({ x: cx, y: cy });
    } else if (C === 'V') {
      const y = num();
      cy = rel ? cy + y : y;
      cur.push({ x: cx, y: cy });
    } else if (C === 'A') {
      const rx = num();
      const ry = num();
      const rot = num();
      const largeArc = num();
      const sweep = num();
      const x = num();
      const y = num();
      for (const p of arcPolyline(cx, cy, rel, rx, ry, rot, largeArc, sweep, x, y)) {
        cx = p.x;
        cy = p.y;
        cur.push(p);
      }
    } else if (C === 'Z') {
      cx = cur[0].x;
      cy = cur[0].y;
    } else {
      throw new Error(`unsupported path command "${cmd}" in "${d}"`);
    }
  }
  return subpaths.filter((s) => s.length > 0);
}

function readSvgGeometry(file) {
  const svg = fs.readFileSync(file, 'utf8');
  const vb = /viewBox\s*=\s*"([^"]+)"/.exec(svg);
  const viewBox = vb ? vb[1].trim().split(/[\s,]+/).map(Number) : [0, 0, 24, 24];
  if (viewBox.length !== 4 || viewBox.some((n) => !Number.isFinite(n))) {
    throw new Error(`bad viewBox in ${file}`);
  }
  const sw = /stroke-width\s*=\s*"([^"]+)"/.exec(svg);
  const strokeWidth = sw ? Number(sw[1]) : 1.5;
  const subpaths = [...svg.matchAll(/d\s*=\s*"([^"]+)"/g)]
    .flatMap((m) => parsePath(m[1]))
    .filter((sp) => sp.length > 0);
  if (subpaths.length === 0) throw new Error(`no path data found in ${file}`);
  return { viewBox, strokeWidth, subpaths };
}

/* ------------------------------------------------- geometry preparation --- */

function buildScene() {
  const { viewBox, strokeWidth, subpaths } = readSvgGeometry(SVG_PATH);
  if (!(strokeWidth > 0)) throw new Error(`bad stroke-width in ${SVG_PATH}`);

  // Bounding box of the stroked glyph (half stroke width padding).
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const sp of subpaths) {
    for (const p of sp) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  const pad = strokeWidth / 2;
  minX -= pad; minY -= pad; maxX += pad; maxY += pad;

  const [vbX, vbY, vbW, vbH] = viewBox;
  if (minX < vbX - 0.5 || minY < vbY - 0.5 || maxX > vbX + vbW + 0.5 || maxY > vbY + vbH + 0.5) {
    throw new Error(`stroked glyph box ${minX}..${maxX} x ${minY}..${maxY} escapes viewBox ${viewBox.join(" ")}`);
  }

  // Uniform scale so the glyph fills the central ~70% of the canvas.
  const scale = Math.min((GLYPH_FILL * WIDTH) / (maxX - minX), (GLYPH_FILL * HEIGHT) / (maxY - minY));
  const originX = (minX + maxX) / 2;
  const originY = (minY + maxY) / 2;
  const toDevice = (p) => ({
    x: WIDTH / 2 + (p.x - originX) * scale,
    y: HEIGHT / 2 + (p.y - originY) * scale,
  });

  const glyph = subpaths.map((sp) => sp.map(toDevice));

  // Stroke segments (round caps and round joins fall out of the distance test).
  const segs = [];
  const pushSeg = (a, b) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    segs.push({ x1: a.x, y1: a.y, dx, dy, len2: dx * dx + dy * dy });
  };
  for (const sp of glyph) for (let i = 0; i + 1 < sp.length; i++) pushSeg(sp[i], sp[i + 1]);

  // Closed interior of the flask: the body subpath (the one containing the
  // arcs) closed by the rim edge between the two neck walls.
  const body = glyph.reduce((best, sp) => (sp.length > best.length ? sp : best), []);
  const interior = body.slice();
  interior.push(body[0]); // implicit close for the point-in-polygon test

  const polySegs = [];
  for (let i = 0; i + 1 < interior.length; i++) {
    const a = interior[i];
    const b = interior[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    polySegs.push({ x1: a.x, y1: a.y, dx, dy, len2: dx * dx + dy * dy });
  }

  const glyphBox = {
    minX: WIDTH / 2 + (minX - originX) * scale,
    maxX: WIDTH / 2 + (maxX - originX) * scale,
    minY: HEIGHT / 2 + (minY - originY) * scale,
    maxY: HEIGHT / 2 + (maxY - originY) * scale,
  };

  return {
    segs,
    polySegs,
    interior,
    glyphBox,
    halfWidth: (strokeWidth / 2) * scale,
    liquidTopY: HEIGHT / 2 + (LIQUID_SURFACE_VB - originY) * scale,
    scale,
    strokeWidth,
  };
}

function distToSegs(x, y, segs) {
  let best = Infinity;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    let t = s.len2 === 0 ? 0 : ((x - s.x1) * s.dx + (y - s.y1) * s.dy) / s.len2;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const ddx = x - (s.x1 + t * s.dx);
    const ddy = y - (s.y1 + t * s.dy);
    const d = ddx * ddx + ddy * ddy;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Signed distance to the rounded-square background (< 0 means inside). */
function roundedRectSignedDistance(x, y) {
  // Rounded square = core square (half extent WIDTH/2 - CORNER_RADIUS) dilated by CORNER_RADIUS.
  const qx = Math.abs(x - WIDTH / 2) - (WIDTH / 2 - CORNER_RADIUS);
  const qy = Math.abs(y - HEIGHT / 2) - (HEIGHT / 2 - CORNER_RADIUS);
  const mx = Math.max(qx, 0);
  const my = Math.max(qy, 0);
  return Math.hypot(mx, my) + Math.min(Math.max(qx, qy), 0) - CORNER_RADIUS;
}

/* ----------------------------------------------------------- rasteriser --- */

function renderRgba(scene) {
  const { segs, polySegs, interior, glyphBox, halfWidth, liquidTopY } = scene;
  const samples = new Uint8Array(WIDTH * HEIGHT * 4);
  const step = 1 / SUPERSAMPLE;
  const boxMinX = glyphBox.minX - 1;
  const boxMaxX = glyphBox.maxX + 1;
  const boxMinY = glyphBox.minY - 1;
  const boxMaxY = glyphBox.maxY + 1;

  for (let py = 0; py < HEIGHT; py++) {
    for (let px = 0; px < WIDTH; px++) {
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let sumA = 0;

      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        const y = py + (sy + 0.5) * step;
        const t = y / (HEIGHT - 1);
        const bgR = lerp(BG_TOP[0], BG_BOTTOM[0], t);
        const bgG = lerp(BG_TOP[1], BG_BOTTOM[1], t);
        const bgB = lerp(BG_TOP[2], BG_BOTTOM[2], t);
        const liqR = lerp(LIQUID_TOP[0], LIQUID_BOTTOM[0], t);
        const liqG = lerp(LIQUID_TOP[1], LIQUID_BOTTOM[1], t);
        const liqB = lerp(LIQUID_TOP[2], LIQUID_BOTTOM[2], t);

        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const x = px + (sx + 0.5) * step;

          const bgCov = clamp01((0.5 - roundedRectSignedDistance(x, y)) / AA_BAND);
          if (bgCov <= 0) continue; // outside the rounded square -> fully transparent

          let r = bgR;
          let g = bgG;
          let b = bgB;

          if (x >= boxMinX && x <= boxMaxX && y >= boxMinY && y <= boxMaxY) {
            // Glass / liquid inside the flask interior.
            if (pointInPolygon(x, y, interior)) {
              const wall = clamp01((distToSegs(x, y, polySegs) + 0.5) / AA_BAND);
              const surface = clamp01((y - liquidTopY + 0.5) / AA_BAND);
              const liquid = wall * surface;
              r = lerp(lerp(r, GLASS_TINT[0], GLASS_TINT_ALPHA * wall), liqR, liquid);
              g = lerp(lerp(g, GLASS_TINT[1], GLASS_TINT_ALPHA * wall), liqG, liquid);
              b = lerp(lerp(b, GLASS_TINT[2], GLASS_TINT_ALPHA * wall), liqB, liquid);
            }

            // Flask line-art: distance-to-polyline gives round caps + round joins.
            const strokeCov = clamp01((halfWidth + 0.5 - distToSegs(x, y, segs)) / AA_BAND);
            if (strokeCov > 0) {
              r = lerp(r, STROKE_RGB[0], strokeCov);
              g = lerp(g, STROKE_RGB[1], strokeCov);
              b = lerp(b, STROKE_RGB[2], strokeCov);
            }
          }

          sumR += r * bgCov;
          sumG += g * bgCov;
          sumB += b * bgCov;
          sumA += bgCov;
        }
      }

      const o = (py * WIDTH + px) * 4;
      if (sumA <= 0) continue; // alpha 0, RGB 0
      const n = SUPERSAMPLE * SUPERSAMPLE;
      // sumR/sumG/sumB are coverage-weighted sums in 0..255 (unpremultiplied result)
      samples[o] = Math.max(0, Math.min(255, Math.round(sumR / sumA)));
      samples[o + 1] = Math.max(0, Math.min(255, Math.round(sumG / sumA)));
      samples[o + 2] = Math.max(0, Math.min(255, Math.round(sumB / sumA)));
      samples[o + 3] = Math.max(0, Math.min(255, Math.round((sumA / n) * 255)));
    }
  }
  return samples;
}

/* --------------------------------------------------------- PNG encoder --- */

function rawScanlines(rgba) {
  const stride = WIDTH * 4;
  const raw = Buffer.alloc(HEIGHT * (1 + stride));
  for (let y = 0; y < HEIGHT; y++) {
    const dst = y * (1 + stride);
    raw[dst] = 0; // filter type 0 (None) for every scanline
    for (let i = 0; i < stride; i++) raw[dst + 1 + i] = rgba[y * stride + i];
  }
  return raw;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(raw) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(WIDTH, 0);
  ihdr.writeUInt32BE(HEIGHT, 4);
  ihdr[8] = BIT_DEPTH;
  ihdr[9] = COLOR_TYPE;
  ihdr[10] = 0; // compression method: deflate
  ihdr[11] = 0; // filter method: adaptive
  ihdr[12] = 0; // interlace: none
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })), // exactly one IDAT
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/* --------------------------------------------------------- verification --- */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Independent re-check of the written file: signature, chunk framing, every
 * CRC, IHDR fields, exactly one IDAT, inflated raw length, filter bytes.
 * When `expectedRaw` is supplied the decoded pixels must match it byte for byte.
 */
function verifyPng(file, expectedRaw) {
  const checks = [];
  const fail = (msg) => {
    checks.push({ ok: false, check: msg });
    throw new Error(`verification failed: ${msg}`);
  };
  const pass = (msg) => checks.push({ ok: true, check: msg });

  const buf = fs.readFileSync(file);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) fail('PNG signature mismatch');
  pass('8-byte PNG signature 89 50 4E 47 0D 0A 1A 0A');

  const idatParts = [];
  let ihdr = null;
  let sawIend = false;
  let offset = 8;
  let chunkCount = 0;

  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buf.length) fail(`chunk ${type} truncated at offset ${offset}`);
    const data = buf.subarray(dataStart, dataEnd);
    const storedCrc = buf.readUInt32BE(dataEnd);
    const computed = crc32(Buffer.concat([Buffer.from(type, 'latin1'), data]));
    if (storedCrc !== computed) {
      fail(`CRC mismatch in ${type} (stored 0x${storedCrc.toString(16)}, computed 0x${computed.toString(16)})`);
    }
    chunkCount++;

    if (type === 'IHDR') {
      if (ihdr) fail('duplicate IHDR chunk');
      if (length !== 13) fail(`IHDR length ${length}, expected 13`);
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      };
    } else if (type === 'IDAT') {
      idatParts.push(data);
    } else if (type === 'IEND') {
      if (length !== 0) fail('IEND must be empty');
      sawIend = true;
      if (dataEnd + 4 !== buf.length) fail('trailing bytes after IEND');
    } else if (type === 'tIME' || type === 'tEXt' || type === 'iTXt' || type === 'zTXt') {
      fail(`unexpected metadata chunk ${type} (output must be byte-reproducible)`);
    }
    offset = dataEnd + 4;
  }

  if (!ihdr) fail('missing IHDR chunk');
  if (!sawIend) fail('missing IEND chunk');
  if (offset !== buf.length) fail('truncated chunk stream');
  pass(`${chunkCount} chunks framed correctly, every CRC recomputed and matching`);

  if (ihdr.width !== WIDTH) fail(`IHDR width ${ihdr.width}, expected ${WIDTH}`);
  if (ihdr.height !== HEIGHT) fail(`IHDR height ${ihdr.height}, expected ${HEIGHT}`);
  if (ihdr.bitDepth !== BIT_DEPTH) fail(`IHDR bit depth ${ihdr.bitDepth}, expected ${BIT_DEPTH}`);
  if (ihdr.colorType !== COLOR_TYPE) fail(`IHDR color type ${ihdr.colorType}, expected ${COLOR_TYPE} (8-bit RGBA)`);
  if (ihdr.compression !== 0) fail(`IHDR compression ${ihdr.compression}, expected 0`);
  if (ihdr.filter !== 0) fail(`IHDR filter method ${ihdr.filter}, expected 0`);
  if (ihdr.interlace !== 0) fail(`IHDR interlace ${ihdr.interlace}, expected 0 (non-interlaced)`);
  pass(`IHDR ${ihdr.width}x${ihdr.height} bitDepth=${ihdr.bitDepth} colorType=${ihdr.colorType} interlace=0`);

  if (idatParts.length !== 1) fail(`${idatParts.length} IDAT chunks, expected exactly 1`);
  pass('exactly one IDAT chunk');

  const raw = zlib.inflateSync(Buffer.concat(idatParts));
  const expectedLen = HEIGHT * (1 + WIDTH * 4);
  if (raw.length !== expectedLen) fail(`inflated IDAT is ${raw.length} bytes, expected ${expectedLen}`);
  pass(`inflated IDAT length ${raw.length} == height * (1 + width*4)`);

  const stride = WIDTH * 4;
  for (let y = 0; y < HEIGHT; y++) {
    const f = raw[y * (1 + stride)];
    if (f !== 0) fail(`scanline ${y} uses filter type ${f}, expected 0`);
  }
  pass(`all ${HEIGHT} scanline filter bytes are 0 (None)`);

  if (expectedRaw) {
    if (!raw.equals(expectedRaw)) fail('decoded pixels do not match the rendered scanlines byte for byte');
    pass('decoded pixels identical to the rendered scanlines (lossless round trip)');
  }

  // Content sanity checks on the decoded pixels (independent of the renderer).
  const pixel = (x, y) => {
    const i = y * (1 + stride) + 1 + x * 4;
    return { r: raw[i], g: raw[i + 1], b: raw[i + 2], a: raw[i + 3] };
  };
  for (const [x, y] of [[0, 0], [WIDTH - 1, 0], [0, HEIGHT - 1], [WIDTH - 1, HEIGHT - 1]]) {
    if (pixel(x, y).a !== 0) fail(`canvas corner (${x},${y}) is not transparent (rounded corner missing)`);
  }
  pass('all four canvas corners transparent (rounded-square background)');
  if (pixel(WIDTH / 2, HEIGHT / 2).a !== 255) fail('centre pixel is not fully opaque');
  pass('centre pixel fully opaque');

  let lightMinX = Infinity;
  let lightMaxX = -1;
  let lightMinY = Infinity;
  let lightMaxY = -1;
  let lightCount = 0;
  let liquidCount = 0;
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const p = pixel(x, y);
      if (p.a < 200) continue;
      if (p.r >= 0xd0 && p.g >= 0xd0 && p.b >= 0xd0) {
        lightCount++;
        if (x < lightMinX) lightMinX = x;
        if (x > lightMaxX) lightMaxX = x;
        if (y < lightMinY) lightMinY = y;
        if (y > lightMaxY) lightMaxY = y;
      } else if (p.r >= 0x80 && p.g >= 0x60 && p.b <= 0x70 && p.r > p.b + 0x30) {
        liquidCount++;
      }
    }
  }
  if (lightCount < 2000) fail(`only ${lightCount} line-art pixels found - glyph missing or too thin`);
  if (liquidCount < 1000) fail(`only ${liquidCount} liquid pixels found - liquid fill missing`);
  const gw = lightMaxX - lightMinX + 1;
  const gh = lightMaxY - lightMinY + 1;
  if (gw > WIDTH * 0.78 || gh > HEIGHT * 0.78) fail(`glyph bounding box ${gw}x${gh} exceeds the central 78% of the canvas`);
  pass(`glyph present: ${lightCount} line-art px in a ${gw}x${gh} box (central ${Math.round((gw / WIDTH) * 100)}%x${Math.round((gh / HEIGHT) * 100)}%), ${liquidCount} liquid px`);

  return { checks, ihdr, raw };
}

/* --------------------------------------------------------------- main --- */

function main() {
  const argv = process.argv.slice(2);
  const verifyOnly = argv.includes('--verify');
  const verbose = argv.includes('--verbose') || verifyOnly;

  let png;
  let raw = null;

  if (verifyOnly) {
    if (!fs.existsSync(PNG_PATH)) throw new Error(`${PNG_PATH} does not exist; run without --verify first`);
  } else {
    const scene = buildScene();
    raw = rawScanlines(renderRgba(scene));
    png = encodePng(raw);
    fs.mkdirSync(path.dirname(PNG_PATH), { recursive: true });
    fs.writeFileSync(PNG_PATH, png);
  }

  const result = verifyPng(PNG_PATH, raw);
  const buf = fs.readFileSync(PNG_PATH);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');

  if (verbose) {
    for (const c of result.checks) process.stderr.write(`  [${c.ok ? 'ok' : 'FAIL'}] ${c.check}\n`);
    process.stderr.write(`  verified ${PNG_PATH}: ${buf.length} bytes, sha256 ${sha256}\n`);
  }

  const summary = {
    path: PNG_PATH,
    bytes: buf.length,
    sha256,
    width: result.ihdr.width,
    height: result.ihdr.height,
    bitDepth: result.ihdr.bitDepth,
    colorType: result.ihdr.colorType,
  };
  process.stdout.write(JSON.stringify(summary) + '\n');
}

try {
  main();
} catch (err) {
  process.stderr.write(`${err && err.message ? err.message : String(err)}\n`);
  process.exitCode = 1;
}
