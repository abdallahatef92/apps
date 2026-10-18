# Themes

The app ships four layout themes, chosen in **Settings › Appearance** and applied as
`data-theme` on `<html>`. Palettes come from the Power BI layout-design skill's library.
Every chart colour below was run through the dataviz validator
(`validate_palette.js`) against that theme's `--surface`; re-run it before changing one.

| id | Label | Mode | Palette | Character |
|---|---|---|---|---|
| `crypto` (default) | Control room | dark | Crypto / Trading | Vivid blue on navy; blue = on track, orange = over |
| `technical` | Technical | dark | Technical / precise | Teal/cyan on slate, engineering register |
| `finance` | Finance | light | Finance / Banking | Trust-first, high-contrast blue on white |
| `prof` | Professional | light | Professional Services | Understated indigo, prints well |

Rules that hold in every theme:

- Good/bad money is blue/orange (`--ink-good` / `--ink-bad`, diverging poles), never red/green.
- Status colours (`--good --warning --serious --critical`) are fixed across themes; only
  their badge/banner *ink and tint* tokens change so labels stay readable on light surfaces.
- Categorical series: one validated set per mode (dark set / light set), assigned in fixed order.
- Diverging arms are 4 steps each, index 0 = faintest (nearest the midpoint). On dark that
  is the darkest step, on light the lightest. Each arm passes `--ordinal`.
- Sequential ramp is 7 steps, `--seq-1` = low … `--seq-7` = high. On dark, high is brightest;
  on light, high is darkest.

## Token values

Tokens not listed for a theme keep the structure of the `crypto` block (derive them from
the listed values; e.g. row hover = accent at ~8% alpha).

### crypto (dark) — the current `:root` values in `styles.css`

- surface `#0f1729` (as today), accent `#2f6bf0`, accent-2 `#8ab0ff`, ink-good `#8ab0ff`, ink-bad `#f0a060`
- series (dark set): `#3987e5 #d95926 #199e70 #c98500 #d55181 #008300 #9085e9 #e66767`
- div-mid `#2b3648`; neg arm `#7d4a24 #9c561f #b9661f #d0782a`; pos arm `#2c5a92 #256abf #3987e5 #6da7ec`
- seq: `#0d366b #1c5cab #2a78d6 #3987e5 #6da7ec #9ec5f4 #cde2fb`

### technical (dark)

- plane `#060c10`, surface `#0e1a22`, surface-2 `#142530`, surface-3 `#1b3241`
- border `#25404f`, border-soft `#1a303d`
- text `#eef7fa`, text-2 `#a7c3cd`, text-3 `#6c8b97`
- accent `#157f9f` (button fill, white text), accent-2 `#9fe3f0` (ink), accent-soft `rgba(41,169,201,.16)`,
  accent-line `rgba(95,208,233,.42)`, grad-accent `linear-gradient(135deg,#1f9cc0 0%,#157f9f 100%)`
- ink-good `#7fd3ea`, ink-bad `#ffad66`
- series: dark set (validated against `#0e1a22`)
- div-mid `#2a2f38`; neg arm `#80502a #a8622a #cc762c #e98b3a`; pos arm `#22607a #2b7e9c #3a9cbf #5fbedd`
- seq: `#123247 #17506b #1f7f9a #29a9c9 #5fc8de #9fe3f0 #d2f4fa`
- grid `#18303c`, axis `#2a4655`; background glows teal (`rgba(41,169,201,.12)`, `rgba(95,208,233,.06)`)

### finance (light)

- plane `#dde3eb`, surface `#eef2f6`, surface-2 `#e6ebf1`, surface-3 `#dbe2ea` (softened from pure white — white read as too bright)
- border `#c3cdd9`, border-soft `#d3dbe5`
- text `#0e1c2e`, text-2 `#46586e`, text-3 `#66788e`
- accent `#1f6fc4`, accent-2 `#1f6fc4`, accent-soft `rgba(31,111,196,.10)`, accent-line `rgba(31,111,196,.35)`,
  grad-accent `linear-gradient(135deg,#2b7fd6 0%,#1f6fc4 100%)`
- ink-good `#0f5aa0`, ink-bad `#a5520f`
- series (light set): `#2a78d6 #eb6834 #1baf7a #eda100 #e87ba4 #008300 #4a3aa7 #e34948`
  (orange, aqua, yellow, magenta are under 3:1 on the light surface — relief rule: charts keep legends/tooltips and a table view)
- div-mid `#d3dae3`; neg arm `#df985a #d4803a #c8661e #a5520f`; pos arm `#7fb0e4 #4f93d6 #1f74c4 #0f5aa0`
- seq: `#e7f0fa #c7dcf4 #9cc3ec #6aa7e0 #3a87d0 #1f6fc4 #0f3d70`
- grid `#e6ebf2`, axis `#c5d0de`
- cards flat `--surface` (no gradient, no inset highlight); shadow `0 1px 2px rgba(15,30,50,.06), 0 4px 14px rgba(15,30,50,.06)`;
  no background glow; sidebar `#e6ebf1` with a right border; top bar `rgba(230,235,241,.92)`
- status ink on light: good `#0a7a0a`, warning `#8a5a00`, bad/critical `#b02a2a`, info = accent

### prof (light)

Same structure as `finance`, with:

- plane `#dfe1e8`, surface `#eff0f4`, surface-2 `#e7e9ef`, surface-3 `#dcdfe7`, border `#c6cad6`, border-soft `#d6d9e2`
- text `#161c2e`, text-2 `#4a5168`, text-3 `#6a7088`
- accent / accent-2 `#3f5aa8`, accent-soft `rgba(63,90,168,.10)`, accent-line `rgba(63,90,168,.35)`,
  grad-accent `linear-gradient(135deg,#4b67b8 0%,#3f5aa8 100%)`
- ink-good `#33498f`, ink-bad `#934f12`
- series: light set
- div-mid `#d6d9e1`; neg arm `#d9925a #c97a3a #b5651d #934f12`; pos arm `#8d9fd6 #6b80c4 #4a63b0 #33498f`
- seq: `#eceff8 #d3daef #b0bde2 #8a9bd1 #647bbd #3f5aa8 #23336a`

## Appearance picker (Settings)

A card titled **Appearance** at the top of Settings: one tile per theme in a responsive grid
(`.grid.k4`). Each tile shows the label, a `dark`/`light` mode badge, a one-line character
description, and a strip of five swatches (surface, accent, ink-good, ink-bad, series-2). The
active tile has the accent border and an "Active" badge. Clicking a tile applies the theme
immediately and stores the id in `localStorage` (`ci.theme`); an unknown or missing value
falls back to `crypto`.
