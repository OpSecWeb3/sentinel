# Sentinel Design System

> Terminal-first. Security-native. Dense by default.

Sentinel is a security monitoring platform built for engineers. The design system reflects that: monospace everywhere, aggressive information density, a single green signal color against near-black, and zero decorative chrome.

---

## Design Philosophy

### 1. Terminal Aesthetic
Every element reads like a tool, not a product. JetBrains Mono is the sole font family across all UI text — not just code blocks. This isn't a stylistic flourish; it's a signal to users that Sentinel operates in their domain. The font carries technical credibility and makes dense tabular data scannable.

### 2. Signal vs. Noise
Color is used semantically, not decoratively. The primary brand green (`hsl(142, 71%, 45%)`) appears only where there's meaning: cleared alerts, active states, CTAs, focus rings. Neutral grays do everything else. This means when green appears, it carries weight.

### 3. Density First
Security operators don't want whitespace — they want more data per viewport. Component defaults are compact (`text-xs`, `text-sm`, `p-3`/`p-4`) and table-optimized. Spacing expands intentionally, not as padding theater.

### 4. Dark Mode Native
The canonical experience is dark mode. The dark palette (`0 0% 3%` background, `0 0% 5%` cards) approaches true black without harsh contrast, reducing eye fatigue during extended incident response sessions. Light mode is a complete inverse, not an afterthought.

---

## Color

### Brand Primary — Security Green
```
hsl(142, 71%, 45%)   →  #22c55e-adjacent (slightly less saturated, more trustworthy)
```
**Rationale:** Green has universal meaning in security: "clear", "healthy", "allowed". This specific value sits between "too bright" (neon/playful) and "too dull" (muted/boring). It reads at 4.5:1 contrast on dark backgrounds, meeting WCAG AA.

**Usage rules:**
- Active nav tabs, focus rings, primary buttons
- Success/cleared states in badges
- Text glow effects for emphasis elements
- Never use for decorative purposes

### Semantic Colors
| Token | Value | Use |
|-------|-------|-----|
| `--primary` | `hsl(142, 71%, 45%)` | Brand green — active, success, CTA |
| `--destructive` | `hsl(0, 84%, 60%)` | Critical alerts, delete actions |
| `--warning` | `hsl(48, 96%, 53%)` | Degraded state, non-critical alerts |
| `--muted-foreground` | `hsl(0, 0%, 45–50%)` | Metadata, secondary labels |
| `--border` | `hsl(0, 0%, 14%)` dark / `hsl(0, 0%, 90%)` light | All structural dividers |

### Dark Mode Palette
The dark palette is intentionally cool-neutral (no blue tint). Cards are `0 0% 5%` — darker than typical dark modes — to create clear hierarchy without borders. Backgrounds step in 2–3% luminosity increments: `3% → 5% → 10% → 12% → 14%`.

---

## Typography

### Single Font: JetBrains Mono
```
font-family: 'JetBrains Mono', 'Fira Code', 'SF Mono', 'Cascadia Code', ui-monospace, monospace
```
**Rationale:** One font, zero decisions. Monospace ensures column alignment in tables (critical for log timestamps, counts, hashes). JetBrains Mono has superior legibility at small sizes compared to Courier or system-monospace, and supports ligatures for operators without distracting from security data.

### Type Scale
| Class | Size | Line Height | Use |
|-------|------|-------------|-----|
| `text-xs` | 12px | 16px | Badges, table metadata, filter chips |
| `text-sm` | 14px | 20px | Primary body, table rows, inputs, most UI |
| `text-xl` | 20px | 28px | Page titles only |

**Rationale:** Three sizes covers everything. Security dashboards don't need editorial typography hierarchy — they need consistent legibility at dense scales.

### Letter Spacing
- `tracking-wider` (0.05em) on card titles and section labels creates a subtle shift in register between "heading" and "content" without changing size or weight. Avoids the need for additional heading levels.

---

## Spacing

4px base grid. All spacing tokens are multiples of 4px (with 6px/10px as intentional half-steps for compact component padding).

| Token | Value | Use |
|-------|-------|-----|
| `2` | 8px | Icon-to-label gap, tight inline spacing |
| `3` | 12px | Compact component padding (filter chips, badges) |
| `4` | 16px | Standard card body padding, section gaps |
| `6` | 24px | Card header padding, page-level gutters |

**Rationale:** Security UIs need to pack more data than typical SaaS. The compact spacing defaults (`p-3`, `px-2.5`, `py-1.5`) allow tables and lists to show 30–40% more rows than an 8px grid would at equivalent font sizes.

---

## Border Radius

Near-zero. Maximum 4px.

| Token | Value | Use |
|-------|-------|-----|
| `sm` | 0px | Inputs, most interactive elements |
| `md` | 2px | Dropdowns, popovers |
| `lg` | 4px | Cards, modals (base `--radius` token) |
| `full` | 9999px | Badges only |

**Rationale:** Rounded corners signal "friendly consumer app." Sharp corners signal "precision tool." Sentinel is the latter. The 2–4px radius on containers prevents the UI from feeling harsh while avoiding the rounded-everything look that's become shorthand for generic SaaS.

---

## Shadows

Shadows are functional, not decorative.

| Name | Value | Use |
|------|-------|-----|
| `dropdown` | `shadow-lg shadow-black/20` | Popovers, dropdowns, command palettes |
| `glow-sm` | `0 0 8px hsl(142,71%,45%,0.4)` | Text glow on `.text-glow` |
| `glow-md` | `0 0 12px + 24px hsl(...)` | Strong primary emphasis |
| `pulse-ring` | Animated box-shadow | Primary CTA button pulse |

**Rationale:** On dark backgrounds, box shadows don't create depth — they create ambiguity. The glow effects are used instead to draw attention to active or interactive states, leaning into the terminal aesthetic.

---

## Animation

### Principles
1. **Entry only** — elements animate in, never out (no unmount animations)
2. **Content-first** — animations are 100–200ms, never more than 600ms
3. **Stagger for lists** — grid/list items cascade at 40ms intervals to imply data loading
4. **Ambient for status** — blink (cursor), pulse-glow (CTA) run on security-relevant elements to indicate live state

### Keyframes
| Name | Duration | Use |
|------|----------|-----|
| `blink` | 1s step-end ∞ | Terminal cursor, live indicator |
| `animate-in` | 100ms ease-out | Dropdown/popover entry |
| `content-ready` | 200ms ease-out | Page section entry |
| `fade-in-up` | 600ms ease-out | Scroll-reveal sections |
| `pulse-glow` | 3s ease-in-out ∞ | Primary CTA ambient pulse |
| `animate-stagger > *` | 200ms + delay cascade | Event list / table batch load |

### Do not add
- Exit/unmount animations
- Parallax or scroll-driven transforms
- Skeleton loaders with shimmer (use opacity fade instead)
- Spring physics (out of register with terminal aesthetic)

---

## Component Conventions

### Cards
Cards are the primary layout unit. They use a consistent structure:
- Header: `p-4`, title `text-sm font-semibold tracking-wider`
- Description: `text-xs text-muted-foreground`
- Body: `p-4 pt-0`

No hover elevation changes on cards. Cards are containers, not links.

### Buttons
Five variants. Use the right one:
- `default` — Primary action. Green. One per view.
- `outline` — Secondary action. Bordered, no fill.
- `ghost` — Tertiary / list item actions. No border at rest.
- `destructive` — Destructive confirmation only.
- `link` — Inline text actions only.

### Badges
Status indicators. Always monospace. Six semantic variants: `default`, `secondary`, `destructive`, `success`, `warning`, `outline`.

**Rule:** Never use color alone to convey status — always pair with text label.

### Inputs / Search
Inputs are borderless within their container — the container provides the border. Focus shifts the container border to `--primary`, not the input itself. This keeps the focus state visible at the field level, not the element level.

### Nav Tabs
Bottom-border active indicator only. No background fill on active tab. The `border-b-2 border-primary` on the active tab and `border-transparent` on inactive keeps navigation legible without consuming vertical space.

---

## Effects

### Scanlines
`.scanlines::after` applies a subtle 4px repeating horizontal gradient at 3% opacity. Use sparingly — on hero sections or terminal output areas. Not on data tables.

### Text Glow
```css
.text-glow        → text-shadow: 0 0 8px hsl(var(--primary) / 0.4)
.text-glow-strong → text-shadow: 0 0 12px ... + 0 0 24px ...
```
Use on primary CTAs, live status indicators, and brand-adjacent headlines. Not on body text.

### Gradient Text
`.text-gradient-primary` — Light green to brighter green. Use on marketing/hero text only, not inside the application shell.

---

## Anti-Patterns

These patterns are explicitly avoided in Sentinel:

| Pattern | Why Avoided |
|---------|-------------|
| Large border radius (>8px) | Consumer app signal, wrong register |
| Purple/blue gradients | Generic AI-generated SaaS default |
| Glass morphism cards | Decorative, adds rendering cost, zero utility |
| Serif or display fonts | Wrong domain register |
| Skeleton shimmer loaders | Distracting — use fade-in-up instead |
| Hover card elevation (box-shadow on hover) | Cards aren't links |
| Color-only status indicators | Accessibility failure |
| Animations >600ms | Breaks perceived performance |
| Icon-only buttons without tooltip | Accessibility failure |

---

## CSS Custom Properties Reference

```css
/* Paste into :root / .dark to bootstrap the system */

:root {
  --background: 0 0% 100%;
  --foreground: 0 0% 9%;
  --card: 0 0% 100%;
  --card-foreground: 0 0% 9%;
  --popover: 0 0% 100%;
  --popover-foreground: 0 0% 9%;
  --primary: 142 71% 45%;
  --primary-foreground: 0 0% 2%;
  --secondary: 0 0% 96%;
  --secondary-foreground: 0 0% 9%;
  --muted: 0 0% 96%;
  --muted-foreground: 0 0% 45%;
  --accent: 0 0% 96%;
  --accent-foreground: 0 0% 9%;
  --destructive: 0 84% 60%;
  --destructive-foreground: 0 0% 98%;
  --success: 142 71% 45%;
  --success-foreground: 0 0% 2%;
  --warning: 48 96% 53%;
  --warning-foreground: 0 0% 2%;
  --border: 0 0% 90%;
  --input: 0 0% 90%;
  --ring: 142 71% 45%;
  --radius: 0.25rem;
}

.dark {
  --background: 0 0% 3%;
  --foreground: 0 0% 85%;
  --card: 0 0% 5%;
  --card-foreground: 0 0% 85%;
  --popover: 0 0% 5%;
  --popover-foreground: 0 0% 85%;
  --primary: 142 71% 45%;
  --primary-foreground: 0 0% 2%;
  --secondary: 0 0% 10%;
  --secondary-foreground: 0 0% 85%;
  --muted: 0 0% 10%;
  --muted-foreground: 0 0% 50%;
  --accent: 0 0% 12%;
  --accent-foreground: 0 0% 85%;
  --destructive: 0 72% 51%;
  --destructive-foreground: 0 0% 98%;
  --success: 142 71% 45%;
  --success-foreground: 0 0% 2%;
  --warning: 48 96% 53%;
  --warning-foreground: 0 0% 2%;
  --border: 0 0% 14%;
  --input: 0 0% 14%;
  --ring: 142 71% 45%;
  --radius: 0.25rem;
}
```

---

*Generated by `/design-system generate` — Sentinel v1.0.0*
