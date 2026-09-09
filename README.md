# reogrid-fonts

Subsetted CJK font packages for [ReoGrid](https://web.reogrid.net) PDF export.

Each package ships three **static** faces — Thin (100), Regular (400) and Bold
(700) — instanced from the upstream variable font. See [Weights](#weights).

| Package | Tag | Characters | Per face | Upstream | vs upstream |
|---|---|---|---|---|---|
| `@reogrid/font-sc` | `zh-CN` | 7,714 | ~2,377 KB | 16.95 MB | 1/7 |
| `@reogrid/font-tc` | `zh-TW` | 13,687 | ~4,756 KB | 11.39 MB | 1/2 |
| `@reogrid/font-jp` | `ja` | 6,979 | ~2,558 KB | 9.15 MB | 1/4 |
| `@reogrid/font-kr` | `ko` | 3,201 | ~567 KB | 9.93 MB | 1/18 |

A face is only downloaded when it is used, so registering all three does not
mean fetching all three.

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
import { notoSansSC } from '@reogrid/font-sc';

registerPdfFont('zh-CN', notoSansSC);   // all three weights (sync)
await preloadPdfFont('zh-CN');          // once, at app start

grid.saveAsPdf({ locale: 'zh-CN', filename: 'report.pdf' });
```

Bold cells print with real Bold outlines. To keep the download to one face,
register just that one — `registerPdfFont('zh-CN', loadNotoSansSCRegular)`.

> The per-weight form requires **`@reogrid/pro` 1.6.0 or newer**. `1.5.0`
> accepts a single loader: `registerPdfFont('zh-CN', loadNotoSansSC)` still
> works and registers Regular alone.

Export stays synchronous, so the font has to be resolved beforehand — that is
what `preloadPdfFont` is for. Each face is a `.ttf` next to the package's
`index.js`, resolved through `new URL(…, import.meta.url)`, so bundlers emit it
as an asset rather than inlining it: an app that never exports a PDF never
downloads a font. The same files are served by jsDelivr straight from the
published package, which is where ReoGrid's built-in `locale` fonts come from
when nothing has been registered.

## Weights

Upstream ships one variable file per language, `NotoSansXX[wght].ttf`, and its
`fvar` reads `min 100 / default 100 / max 900`. That default matters more than it
looks: a variable font stores its outlines in `glyf` **at the default coordinate**
and keeps the deltas in `gvar`, so anything that embeds `glyf` without applying
variations draws the font at wght 100 — Thin.

ReoGrid's PDF export embeds glyph outlines and nothing else, so an un-instanced
subset produced uniformly hairline documents, and the synthetic bold (a 4%
outline stroke) had no substance to thicken. The build therefore pins the axis,
once per weight:

```js
await subsetFont(source, text, { targetFormat: 'truetype', variationAxes: { wght } });
```

Each result is a plain static font — `fvar`, `gvar`, `avar`, `HVAR` and `STAT`
are all dropped. Three of them, at 100 / 400 / 700, is what lets a PDF use a
real Bold face for bold cells rather than stroking the outline.

Why three and not nine: a spreadsheet cell is bold or it is not, so Regular and
Bold are the two the grid can ask for. Thin is built because it is the weight
the un-instanced build produced *by accident* — having it on purpose keeps
hairline available to anyone who wants it, and costs one more instancing pass.

harfbuzz updates `OS/2.usWeightClass` when it instances but does **not** rewrite
the `name` table, so all three faces would otherwise call themselves
`NotoSansJP-Thin` — and a PDF's `/BaseFont` would repeat it, which is exactly
the symptom people reported. `scripts/nameTable.mjs` rebuilds the `name` table
(and with it the sfnt directory and checksums) so each face reports its own
weight. `npm run verify` re-reads every emitted face and checks
`OS/2.usWeightClass`, the absence of `fvar`, and the PostScript name.

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
