# reogrid-fonts

Subsetted CJK font packages for [ReoGrid](https://web.reogrid.net) PDF export.

| Package | Tag | Characters | Package | Over the wire | vs upstream |
|---|---|---|---|---|---|
| `@reogrid/font-sc` | `zh-CN` | 7,709 | 2,376 KB | ~1,435 KB | 1/12 |
| `@reogrid/font-tc` | `zh-TW` | 13,682 | 4,758 KB | ~2,686 KB | 1/4 |
| `@reogrid/font-jp` | `ja` | 6,974 | 2,557 KB | ~1,487 KB | 1/6 |
| `@reogrid/font-kr` | `ko` | 3,196 | 566 KB | ~280 KB | 1/36 |

Every package is a **static Regular (wght 400)** instance, not the upstream
variable font — see [Weight](#weight).

## Why this exists

ReoGrid's PDF export embeds glyph outlines, so it needs real font bytes. The
only bundled loader used to be `loadDefaultJapaneseFont()` — and Noto Sans JP
covers barely a third of everyday simplified Chinese. A sheet reading
销售额报表 exported as tofu, with no supported way to fix it.

The obvious repair is "fetch Noto Sans SC instead", but that font is **17 MB**,
served from a CDN that is slow and intermittently unreachable from mainland
China — precisely the users who need it. Shipping a subset through npm removes
the runtime network entirely: it installs from whatever registry mirror the
customer already uses, and it works on the offline intranets common in Chinese
enterprise deployments.

## Usage

```bash
npm install @reogrid/font-sc
```

```ts
import { registerPdfFont, preloadPdfFont } from '@reogrid/pro';
import { loadNotoSansSC } from '@reogrid/font-sc';

registerPdfFont('zh-CN', loadNotoSansSC);   // wire it up (sync)
await preloadPdfFont('zh-CN');              // once, at app start

grid.saveAsPdf({ locale: 'zh-CN', filename: 'report.pdf' });
```

> Requires **`@reogrid/pro` 1.5.0 or newer** — `registerPdfFont` and the
> `locale` option landed in 1.5.0.

Export stays synchronous, so the font has to be resolved beforehand — that is
what `preloadPdfFont` is for. The bytes sit behind a dynamic import, so bundlers
give them their own chunk: an app that never exports a PDF never downloads them.

## Weight

Upstream ships one variable file per language, `NotoSansXX[wght].ttf`, and its
`fvar` reads `min 100 / default 100 / max 900`. That default matters more than it
looks: a variable font stores its outlines in `glyf` **at the default coordinate**
and keeps the deltas in `gvar`, so anything that embeds `glyf` without applying
variations draws the font at wght 100 — Thin.

ReoGrid's PDF export embeds glyph outlines and nothing else, so an un-instanced
subset produced uniformly hairline documents, and the synthetic bold (a 4%
outline stroke) had no substance to thicken. The build therefore pins the axis:

```js
await subsetFont(source, text, { targetFormat: 'truetype', variationAxes: { wght: WEIGHT } });
```

The result is a plain static font — `fvar`, `gvar`, `avar`, `HVAR` and `STAT` are
all dropped, which is also why the packages are roughly half the size they were
before 1.1.0.

One wrinkle: harfbuzz does not rewrite the `name` table when instancing, so the
font still calls itself `NotoSansJP-Thin`, and a PDF's `/BaseFont` will repeat
that name. It is a label, not the outlines. `npm run verify` checks
`OS/2.usWeightClass` and the absence of `fvar` instead, and fails the build if a
package is ever shipped un-instanced again.

## What is in a subset

Each package carries the **classic national standard** for its language, plus
ASCII:

| Tag | Standard | Derived from |
|---|---|---|
| `zh-CN` | GB 2312-80 | rows 1-9, 16-87 |
| `zh-TW` | Big5 | levels 1 and 2 |
| `ja` | JIS X 0208 | rows 1-8, 16-84 |
| `ko` | KS X 1001 | rows 1-9, 16-40 |

Level-2 repertoires are included deliberately: that is where personal and place
names live, and a customer name rendering as tofu is worse than a larger
download. Characters outside the standard fall back to `.notdef` — register your
own bytes if you need wider coverage.

## Building

```bash
npm install
npm run build      # fetch pinned upstream → subset → emit packages/
npm run verify     # independently re-read every emitted font
```

Upstream is pinned to a **commit**, never a branch, in `fonts.config.mjs`.
`@main` would silently change the bytes we publish whenever Google pushes.

Generated packages are not committed — `packages/*` is rebuilt from the pinned
upstream, so the repository stays text-only and auditable.

### Two things the build gets right, non-obviously

**Subsetting uses harfbuzz, not the PDF engine's own subsetter.** pdf-creator's
`buildSubsetFont` deliberately omits `cmap` (a PDF `CIDFontType2` selects glyphs
by CID, so the table is dead weight *there*). Its output is not a usable font
file at all — it cannot be re-parsed, and the engine needs `cmap` to map
characters to glyphs.

**Trail-byte ranges are per-encoding.** WHATWG maps the `gb2312` label onto the
GBK decoder, so widening the trail range to `0x40-0x7E` quietly pulls in all of
GBK — 12,812 characters instead of GB 2312's 7,709 — and nearly doubles the
package. Big5, conversely, genuinely uses both halves; restricting it to
`0xA1-0xFE` drops 銷 額 帳 負 發 貨 訂 and much else.

`npm run verify` exists because both mistakes produce a font that still *looks*
fine. It re-reads each emitted font with its own dependency-free sfnt parser and
asserts that every character the upstream font could supply survived.

## Licence

The Noto fonts are licensed under the [SIL Open Font License 1.1][ofl]; each
package ships its `OFL.txt`, which applies to the subset as well. Their reserved
font name is `Source` (they descend from Adobe's Source Han Sans), which the
`Noto Sans …` names do not use.

The build scripts in this repository are MIT.

[ofl]: https://scripts.sil.org/OFL
