// Font build manifest.
//
// One entry per published package. Everything the build needs — which upstream
// file, which characters, what to call the export — lives here, so adding a
// language is a matter of adding a row.

/**
 * Upstream is pinned to a commit, never a branch: `@main` would silently change
 * the bytes we publish (and the subset we claim to have audited) whenever Google
 * pushes. Bump this deliberately, and re-run the build to see the size diff.
 */
export const GOOGLE_FONTS_SHA = '7ff85c87f93ea6cca5f41c69f2e4edcb90240f26';

export const upstreamUrl = (dir, file) =>
  `https://cdn.jsdelivr.net/gh/google/fonts@${GOOGLE_FONTS_SHA}/ofl/${dir}/${file}`;

/**
 * Character sets are generated from the classic national encodings rather than
 * hand-listed: they are exactly the "everyday business document" repertoires,
 * they are stable, and a reviewer can re-derive them instead of trusting a blob.
 *
 * `ranges` are inclusive [lo, hi] lead/trail byte pairs fed through TextDecoder.
 */
export const FONTS = [
  {
    tag: 'zh-CN',
    pkg: '@reogrid/font-sc',
    dir: 'font-sc',
    export: 'loadNotoSansSC',
    family: 'Noto Sans SC',
    upstream: { dir: 'notosanssc', file: 'NotoSansSC%5Bwght%5D.ttf' },
    // GB 2312-80 in full: symbols/kana/cyrillic (rows 1-9) + level-1 hanzi
    // (rows 16-55) + level-2 (rows 56-87). Level-2 is where personal and place
    // names live, so trimming to level-1 would tofu customer names.
    charset: { encoding: 'gb2312', ranges: [[0xa1, 0xa9], [0xb0, 0xf7]] },
  },
  {
    tag: 'zh-TW',
    pkg: '@reogrid/font-tc',
    dir: 'font-tc',
    export: 'loadNotoSansTC',
    family: 'Noto Sans TC',
    upstream: { dir: 'notosanstc', file: 'NotoSansTC%5Bwght%5D.ttf' },
    // Big5 level-1 (common) hanzi plus the symbol rows.
    charset: { encoding: 'big5', ranges: [[0xa1, 0xc6], [0xc9, 0xf9]] },
  },
  {
    tag: 'ja',
    pkg: '@reogrid/font-jp',
    dir: 'font-jp',
    export: 'loadNotoSansJP',
    family: 'Noto Sans JP',
    upstream: { dir: 'notosansjp', file: 'NotoSansJP%5Bwght%5D.ttf' },
    // JIS X 0208 via EUC-JP: symbols/kana/greek/cyrillic (rows 1-8) + level-1
    // kanji (rows 16-47) + level-2 (rows 48-84), i.e. the full JIS repertoire.
    charset: { encoding: 'euc-jp', ranges: [[0xa1, 0xa8], [0xb0, 0xf4]] },
  },
  {
    tag: 'ko',
    pkg: '@reogrid/font-kr',
    dir: 'font-kr',
    export: 'loadNotoSansKR',
    family: 'Noto Sans KR',
    upstream: { dir: 'notosanskr', file: 'NotoSansKR%5Bwght%5D.ttf' },
    // KS X 1001 via EUC-KR: symbols (rows 1-9) + precomposed hangul (rows 16-40).
    charset: { encoding: 'euc-kr', ranges: [[0xa1, 0xa9], [0xb0, 0xc8]] },
  },
];

/** ASCII is added to every subset — sheets always carry digits and punctuation. */
export const ALWAYS_INCLUDE = Array.from({ length: 0x7f - 0x20 }, (_, i) =>
  String.fromCharCode(0x20 + i),
).join('');

/**
 * Trail bytes to try, per encoding. This is not cosmetic — it decides which
 * repertoire we actually ship:
 *
 * - The EUC-based encodings (GB 2312, EUC-JP, EUC-KR) use 0xA1-0xFE only.
 *   Restricting to that is what pins the subset to the *classic national
 *   standard*: WHATWG maps the `gb2312` label onto the GBK decoder, so opening
 *   the trail range up to 0x40-0x7E silently pulls in all of GBK (12,812 chars
 *   instead of GB 2312's 7,709) and nearly doubles the package.
 * - Big5 genuinely uses both halves, and omitting 0x40-0x7E drops a large share
 *   of traditional Chinese — 銷 額 帳 負 發 貨 訂 among them.
 */
const EUC_TRAIL = [[0xa1, 0xfe]];
const BIG5_TRAIL = [
  [0x40, 0x7e],
  [0xa1, 0xfe],
];
const TRAIL_RANGES = {
  gb2312: EUC_TRAIL,
  'euc-jp': EUC_TRAIL,
  'euc-kr': EUC_TRAIL,
  big5: BIG5_TRAIL,
};

/**
 * Expand a legacy encoding's lead/trail ranges into characters. Undecodable
 * pairs are skipped — the ranges are rectangular but the encodings are not, and
 * the holes are exactly the unassigned code points.
 *
 * Shared by the builder and the verifier on purpose: if they derived the
 * repertoire separately they could drift, and the verifier would be checking
 * the wrong thing.
 */
export function charsetFor({ encoding, ranges }) {
  const decoder = new TextDecoder(encoding, { fatal: true });
  const trails = TRAIL_RANGES[encoding];
  if (!trails) throw new Error(`charsetFor: no trail-byte range defined for '${encoding}'`);
  const chars = new Set();
  for (const [lo, hi] of ranges) {
    for (let lead = lo; lead <= hi; lead += 1) {
      for (const [tLo, tHi] of trails) {
        for (let trail = tLo; trail <= tHi; trail += 1) {
          try {
            const ch = decoder.decode(new Uint8Array([lead, trail]));
            if (ch && ch !== '�') chars.add(ch);
          } catch {
            /* unassigned in this encoding */
          }
        }
      }
    }
  }
  return [...ALWAYS_INCLUDE, ...chars].join('');
}
