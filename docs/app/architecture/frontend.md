# Frontend Architecture

## Technology stack

| Layer | Choice |
|---|---|
| Framework | Next.js 15, App Router |
| UI library | React 19 |
| Styling | Tailwind CSS 3.4 |
| Font | JetBrains Mono (Google Fonts, via `next/font/google`) |
| HTTP client | Custom typed fetch wrappers (`apps/web/src/lib/api.ts`) |
| Component primitives | Custom; `@radix-ui/react-slot` for composable button/link patterns |
| State management | None — page-level `useState` / `useEffect` only |
| Build tool | Next.js Turbopack (development), Next.js webpack (production build) |

## App Router structure

Next.js App Router uses the filesystem to define routes. Sentinel uses two [route groups](https://nextjs.org/docs/app/building-your-application/routing/route-groups) to separate authentication pages from the authenticated dashboard.

```
apps/web/src/app/
├── layout.tsx                  Root layout — applies JetBrains Mono, dark class, JSON-LD schema
├── globals.css                 Tailwind base directives and CSS custom properties (design tokens)
├── page.tsx                    Root redirect — sends unauthenticated users to /login
│
├── (auth)/                     Route group — no shared layout chrome
│   ├── layout.tsx              Minimal layout (centered card, no sidebar)
│   ├── login/
│   │   └── page.tsx            Email + password login form
│   ├── register/
│   │   └── page.tsx            Account creation form
│   └── join-org/
│       └── page.tsx            Accept org invite by token
│
└── (dashboard)/                Route group — full dashboard layout (sidebar + header)
    ├── layout.tsx              Dashboard shell layout wrapper
    ├── dashboard-shell.tsx     Sidebar navigation (tree-style with collapsible module sections), auth guard, user menu
    ├── dashboard/
    │   └── page.tsx            Overview: alert counts, recent events, module status
    ├── detections/
    │   ├── page.tsx            Detection rule list
    │   └── new/
    │       └── page.tsx        Detection rule creation form
    ├── alerts/
    │   └── page.tsx            Alert feed with acknowledge / dismiss actions
    ├── events/
    │   └── page.tsx            Normalized event log with filters
    ├── correlations/
    │   ├── page.tsx            Correlation rule list
    │   └── new/
    │       └── page.tsx        Correlation rule creation form (multi-step wizard)
    ├── channels/
    │   └── page.tsx            Notification channel management (Slack, email)
    ├── settings/
    │   └── page.tsx            Org settings, API keys, member management
    ├── templates/
    │   └── page.tsx            Detection rule template browser
    ├── github/
    │   └── page.tsx            GitHub integration management
    ├── chain/
    │   └── page.tsx            EVM chain integration configuration
    ├── infra/
    │   └── page.tsx            Infrastructure agent management
    ├── registry/
    │   └── page.tsx            Package registry integration management
    └── aws/
        └── page.tsx            AWS integration management
```

### Route groups

Route groups (folders prefixed with parentheses) affect the URL structure and layout inheritance but do not appear in the URL path. The `(auth)` group renders pages inside a minimal centered-card layout with the terminal-style "$ SENTINEL" branding. The `(dashboard)` group renders pages inside the full dashboard shell with the sidebar navigation.

The `(auth)` layout is a client component (`"use client"`) that performs a redirect check on mount: it calls `GET /auth/me` to determine whether the user already has a valid session. If the call succeeds, the user is redirected to `/dashboard` immediately, preventing authenticated users from seeing the login form. If the call fails (401), the user stays on the auth page.

The `(dashboard)` layout is a server component that sets `export const dynamic = "force-dynamic"` to opt all dashboard routes out of static prerendering. The actual navigation chrome (sidebar, header, user menu) lives in a separate client component, `dashboard-shell.tsx`.

This means `/login` uses the auth layout and `/dashboard` uses the dashboard layout, even though both are children of the same `app/` directory.

## Root layout

The root `layout.tsx` applies two settings to every page in the application:

1. **JetBrains Mono font** — loaded via `next/font/google` with subset `latin` and exposed as the CSS variable `--font-mono`. The body applies `font-mono antialiased` Tailwind classes.
2. **Dark mode** — the `<html>` element always carries `className="dark"`. Sentinel has no light mode.

The root layout also injects an Organization JSON-LD schema via `<script type="application/ld+json">` for SEO.

## Data fetching

Sentinel does not use a global state management library. Data fetching follows a straightforward pattern:

1. Page components (`page.tsx`) call the API client on component mount via `useEffect`.
2. Local `useState` holds the fetched data and loading/error states.
3. Mutations (create, update, delete) call the appropriate `apiPost`/`apiPut`/`apiDelete` function and then re-fetch or update local state.

This pattern keeps each page self-contained and avoids the complexity of cache invalidation that global state managers require. The tradeoff is that navigating back to a page triggers a fresh fetch — acceptable for a security dashboard where data freshness matters.

There is no use of Next.js Server Components for data fetching. All pages are client components (`'use client'`) that fetch data from the API server via the browser. This is intentional: it avoids the complexity of managing server-side session cookies in Next.js middleware and keeps the API server as the single authentication boundary.

## API client

The API client lives at `apps/web/src/lib/api.ts`. It provides typed fetch wrappers that handle session authentication, CSRF headers, and error normalization.

### Key design decisions

**Session cookie authentication** — All requests use `credentials: "include"` so the browser automatically attaches the `sentinel.sid` cookie. No token management is needed in the frontend.

**CSRF header** — Every request (including GET) includes `X-Sentinel-Request: 1`. The API server only enforces this header for state-changing requests with an active session cookie, but including it on all requests simplifies the client and avoids edge cases.

**Automatic redirect on 401** — When `handleResponse` receives a 401, it redirects the browser to `/login?next=<current-path>`, preserving the user's intended destination. This check is skipped if the current path is already `/login` or `/register` to avoid redirect loops.

**204 handling** — The `handleResponse` function returns `undefined as T` for 204 No Content responses (used by DELETE endpoints) without attempting to parse the empty body as JSON.

### Available functions

```typescript
apiFetch<T>(path, init?)    // Generic wrapper — use when you need custom options
apiGet<T>(path)             // GET request
apiPost<T>(path, body?)     // POST request with JSON body
apiPut<T>(path, body?)      // PUT request with JSON body
apiPatch<T>(path, body?)    // PATCH request with JSON body
apiDelete<T>(path)          // DELETE request
```

All functions return `Promise<T>` and throw `ApiError` on non-2xx responses. `ApiError` exposes the HTTP `status` code for error-type discrimination.

### Error handling in page components

```typescript
const [error, setError] = useState<string | null>(null);

try {
  const data = await apiGet<Detection[]>('/api/detections');
  setDetections(data);
} catch (err) {
  if (err instanceof ApiError) {
    setError(err.message);
  } else {
    setError('An unexpected error occurred');
  }
}
```

## Design system

### Terminal aesthetic

The dashboard uses a monospace-first, dark-mode-only design language inspired by terminal interfaces. All text is rendered in JetBrains Mono. The color palette uses low-chroma backgrounds with high-contrast text, accent colors that evoke ANSI terminal output, and subtle borders.

Design tokens are defined as CSS custom properties in `globals.css` and referenced by Tailwind utility classes. The token set (`design-tokens.json` at the repository root) is the source of truth; `globals.css` is generated from it.

### Custom UI components

All UI components are in `apps/web/src/components/ui/`. They are implemented directly with Tailwind CSS and React — there is no dependency on a component library such as shadcn/ui or Headless UI. This gives full control over DOM structure, class names, and animation behavior.

The only Radix UI dependency is `@radix-ui/react-slot`, used by the `Button` component to support the `asChild` prop pattern:

```tsx
// Renders as a link styled as a button
<Button asChild>
  <Link href="/detections/new">New Detection</Link>
</Button>
```

Available primitive components include: `Button`, `Input`, `Badge`, `Combobox`, `Select`, `Dialog`, `Table`, `Card`, `Spinner`, and several layout primitives.

### Dark mode

The `dark` class is always present on `<html>`. Tailwind's dark mode variant (`dark:`) is used throughout the component tree for values that need to differ between themes (even though only dark is active). This ensures forward compatibility if a light mode is ever introduced.

## Next.js middleware

The file `apps/web/src/middleware.ts` implements server-side route protection. It runs on every request (excluding `_next/static`, `_next/image`, and `favicon.ico` via the matcher config) and gates dashboard access on the presence of the `sentinel.sid` session cookie.

**Public paths** — The following paths are accessible without a session cookie:

- `/`, `/login`, `/register` (explicit allowlist)
- `/api/*` and `/_next/*` (framework internals)
- `/favicon.ico` and any path ending with a file extension (`/foo.svg`, `/manifest.webmanifest`, etc.)

**Redirect behavior** — If a request targets a non-public path and the `sentinel.sid` cookie is absent or empty, the middleware redirects to `/login?next=<original-path>`. The `next` query parameter preserves the user's intended destination so that the login page can redirect back after successful authentication.

The middleware does not validate the session itself. Session validation is the responsibility of the API server. The middleware only prevents unauthenticated users from receiving server-rendered dashboard HTML, which would be useless without data anyway.

## Additional dependencies

Beyond the standard Next.js and React dependencies, the web application includes:

| Package | Purpose |
|---|---|
| `leaflet` + `react-leaflet` | Renders the infrastructure worldview map (`/infra/worldview`). |
| `lucide-react` | Icon library used throughout the dashboard. |
| `class-variance-authority` | Manages component variant class names (used by `Button`, `Badge`, and similar primitives). |
| `clsx` + `tailwind-merge` | Utility for conditionally merging Tailwind class names. |
| `@sentry/nextjs` | Error tracking and performance monitoring in the browser and on the server. |
