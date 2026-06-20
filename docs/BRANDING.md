# Brand & assets

The Council of Personas identity is **"Sovereign Minimalism"** — a dark, technical,
command-station aesthetic. Diverse advisors (the accent colors) converge into one
synthesis (the central indigo node).

## Assets

| File | Use |
|------|-----|
| [`assets/logo.png`](../assets/logo.png) | Primary mark — council ring + central Chairman gem (1024²) |
| [`assets/logo-512.png`](../assets/logo-512.png) | 512² logo for embeds |
| [`assets/logo-alt.png`](../assets/logo-alt.png) | Alternate mark (network-of-shapes) |
| [`assets/banner.png`](../assets/banner.png) | README / repo header (16:9) |
| [`assets/social-preview.png`](../assets/social-preview.png) | GitHub social preview (1280×640) |
| [`assets/screenshot.png`](../assets/screenshot.png) | App screenshot |
| `app/public/icons/*`, `app/public/favicon.ico` | App favicons (generated from the logo) |

> **GitHub social preview:** Settings → General → Social preview → upload
> `assets/social-preview.png`.

## Palette

| Token | Hex | Use |
|-------|-----|-----|
| Background | `#0b1326` | Deep indigo canvas |
| Surface | `#171f33` | Panels / cards |
| Primary (Council Blue) | `#bcc3ff` / `#2e3a8c` | Chairman, primary actions, links |
| On-surface | `#dae2fd` | Text |
| Red — Skeptic | `#ffb4ab` | Red Team persona |
| Purple — Visionary | `#d2bbff` | Visionary persona |
| Green — Operator | `#57e0a8` | Operator / Pragmatist persona |
| Gold — Domain Expert | `#ffd479` | Domain Expert persona |

## Type

- **Geist** — headlines (technical, sharp)
- **Inter** — body / long-form reading
- **JetBrains Mono** — labels, metadata, and model output ("terminal" feel)

## How the imagery was made

The logo, banner, and social preview were generated with Google's **Nano Banana Pro**
(`nano-banana-pro-preview`, Gemini 3 Pro Image) via the Gemini API, then resized into
favicons with ImageMagick. The same dark-indigo palette and four persona accent colors
were used in the prompts to keep the identity consistent with the app UI. Prompts are
preserved in the project history if you want to regenerate or extend the set.
