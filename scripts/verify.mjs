#!/usr/bin/env node
// Verify the built packages before publishing.
//
// The build is only useful if the emitted font is a *usable font file*, so this
// checks the two things that actually break:
//
//   1. `cmap` survives. The PDF engine maps characters to glyphs through it, and
//      a subsetter tuned for PDF embedding (as pdf-creator's is) drops it — that
//      output cannot be re-parsed at all.
//   2. Every character we claim to ship resolves to a real glyph, not `.notdef`.
//
// Deliberately dependency-free: a verifier that trusts the same library as the
// builder is not a verifier. This reads the sfnt tables directly.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FONTS, charsetFor } from '../fonts.config.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Minimal sfnt table directory reader. */
function tables(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const count = view.getUint16(4);
  const found = new Map();
  for (let i = 0; i < count; i += 1) {
    const at = 12 + i * 16;
    const tag = String.fromCharCode(buf[at], buf[at + 1], buf[at + 2], buf[at + 3]);
    found.set(tag, { offset: view.getUint32(at + 8), length: view.getUint32(at + 12) });
  }
  return { view, found };
}

/** Build a code point → glyph id lookup from cmap format 4 and 12 subtables. */
function readCmap(buf) {
  const { view, found } = tables(buf);
  const cmap = found.get('cmap');
  if (!cmap) throw new Error('missing `cmap` — not a usable font file');

  const base = cmap.offset;
  const n = view.getUint16(base + 2);
  const map = new Map();

  for (let i = 0; i < n; i += 1) {
    const rec = base + 4 + i * 8;
    const sub = base + view.getUint32(rec + 4);
    const format = view.getUint16(sub);

    if (format === 4) {
      const segX2 = view.getUint16(sub + 6);
      const ends = sub + 14;
      const starts = ends + segX2 + 2;
      const deltas = starts + segX2;
      const rangeOffsets = deltas + segX2;
      for (let s = 0; s < segX2 / 2; s += 1) {
        const end = view.getUint16(ends + s * 2);
        const start = view.getUint16(starts + s * 2);
        const delta = view.getInt16(deltas + s * 2);
        const ro = view.getUint16(rangeOffsets + s * 2);
        for (let cp = start; cp <= end && cp !== 0xffff; cp += 1) {
          let gid;
          if (ro === 0) gid = (cp + delta) & 0xffff;
          else {
            const at = rangeOffsets + s * 2 + ro + (cp - start) * 2;
            if (at + 1 >= buf.byteLength) continue;
            gid = view.getUint16(at);
            if (gid) gid = (gid + delta) & 0xffff;
          }
          if (gid) map.set(cp, gid);
        }
      }
    } else if (format === 12) {
      const groups = view.getUint32(sub + 12);
      for (let g = 0; g < groups; g += 1) {
        const at = sub + 16 + g * 12;
        const start = view.getUint32(at);
        const end = view.getUint32(at + 4);
        const startGid = view.getUint32(at + 8);
        for (let cp = start; cp <= end; cp += 1) map.set(cp, startGid + (cp - start));
      }
    }
  }
  return map;
}

// A few characters per language that must render, spelled out so a regression
// is legible in the failure message rather than a bare count.
const SPOT_CHECKS = {
  'zh-CN': '销售额报表客户账户资产负债发货订单',
  'zh-TW': '銷售額報表客戶帳戶資產負債發貨訂單',
  ja: '請求書合計金額御中株式会社',
  ko: '청구서합계금액주식회사',
};

let failed = 0;

for (const font of FONTS) {
  const dir = join(ROOT, 'packages', font.dir);
  if (!existsSync(join(dir, 'data.js'))) {
    console.error(`✗ ${font.pkg}: not built — run \`npm run build\` first`);
    failed += 1;
    continue;
  }

  const { default: loader } = await import(join(dir, 'index.js'));
  const bytes = await loader();

  try {
    const cmap = readCmap(bytes);
    const declared = [...charsetFor(font.charset)];

    // The bar is what the *upstream font* could supply, not what the encoding
    // defines: a handful of code points in every legacy repertoire (box drawing,
    // some symbol rows) were never drawn by Noto, and demanding them would fail
    // a subset that lost nothing. Anything upstream had, the subset must keep.
    const upstreamPath = join(ROOT, '.cache', `${font.upstream.dir}.ttf`);
    if (!existsSync(upstreamPath)) {
      console.error(`✗ ${font.pkg}: upstream not cached — run \`npm run build\` first`);
      failed += 1;
      continue;
    }
    const upstream = readCmap(await readFile(upstreamPath));
    const expected = declared.filter((c) => upstream.has(c.codePointAt(0)));
    const absentUpstream = declared.length - expected.length;

    const missing = expected.filter((c) => !cmap.has(c.codePointAt(0)));
    const spot = [...SPOT_CHECKS[font.tag]].filter((c) => !cmap.has(c.codePointAt(0)));

    if (missing.length || spot.length) {
      console.error(
        `✗ ${font.pkg}: ${missing.length}/${expected.length} chars lost in subsetting` +
          (missing.length ? ` (e.g. ${missing.slice(0, 12).join('')})` : '') +
          (spot.length ? `, spot-check dropped: ${spot.join('')}` : ''),
      );
      failed += 1;
    } else {
      console.log(
        `✓ ${font.pkg.padEnd(20)} ${String(expected.length).padStart(6)} chars kept, ` +
          `${String((bytes.length / 1024).toFixed(0)).padStart(5)} KB` +
          (absentUpstream ? `   (${absentUpstream} not in upstream)` : ''),
      );
    }
  } catch (error) {
    console.error(`✗ ${font.pkg}: ${error.message}`);
    failed += 1;
  }
}

if (failed) {
  console.error(`\n${failed} package(s) failed verification.`);
  process.exit(1);
}
console.log('\nAll packages verified.');
