---
name: UI Style Preferences
description: User's preferences for filter/search/navigation UI patterns in the Sentinel web app
type: feedback
---

Move away from `--flag button-row` and `--grep > input` terminal CLI-style filter/search UI toward more traditional patterns, while keeping the terminal/hacker aesthetic.

**Why:** The old `--flag  all  [active]  paused` button rows and `--grep > input` felt like developer tooling, not usable UI. Traditional searchbars, dropdowns, and tabs are clearer.

**How to apply:**
- **Search:** Use `SearchInput` component (`apps/web/src/components/ui/search-input.tsx`) — clean searchbar with Search icon and [x] clear button. Still mono, still terminal-colored, but recognizable as a search field.
- **Filters:** Use `FilterBar` component (`apps/web/src/components/ui/filter-bar.tsx`) — row of compact labeled dropdown chips (`label: value ▾`). Active filters show in primary green.
- **Sub-navigation/tabs:** Use `NavTabs` component (`apps/web/src/components/ui/nav-tabs.tsx`) — proper tab bar with bottom-border active indicator using `usePathname()`. Replaces flat inline link rows.
- Still OK to keep: `$`/`>`/`[bracket]` in page titles, action buttons, status labels — these are branding not UX friction.
