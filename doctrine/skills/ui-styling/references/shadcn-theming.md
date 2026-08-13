# shadcn/ui Theming & Customization (Tailwind v4)

Theme configuration, CSS variables, dark mode, and component customization
for the current shadcn/ui + Tailwind v4 convention. If a project has a
`tailwind.config.ts` with a shadcn `colors` block, it is on the legacy v3
convention — see the appendix at the bottom. Never mix the two in one
project.

## The v4 CSS Variable System

Everything lives in one CSS file (`app/globals.css` or `src/index.css`).
There is **no `tailwind.config.ts`** and **no config-file `colors`
section** — utilities are generated from `@theme inline`.

Four parts, in order:

```css
@import "tailwindcss";
@import "tw-animate-css";

@custom-variant dark (&:is(.dark *));

:root {
  --radius: 0.625rem;
  --background: oklch(1 0 0);
  --foreground: oklch(0.145 0 0);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.145 0 0);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.145 0 0);
  --primary: oklch(0.205 0 0);
  --primary-foreground: oklch(0.985 0 0);
  --secondary: oklch(0.97 0 0);
  --secondary-foreground: oklch(0.205 0 0);
  --muted: oklch(0.97 0 0);
  --muted-foreground: oklch(0.556 0 0);
  --accent: oklch(0.97 0 0);
  --accent-foreground: oklch(0.205 0 0);
  --destructive: oklch(0.577 0.245 27.325);
  --border: oklch(0.922 0 0);
  --input: oklch(0.922 0 0);
  --ring: oklch(0.708 0 0);
}

.dark {
  --background: oklch(0.145 0 0);
  --foreground: oklch(0.985 0 0);
  --card: oklch(0.205 0 0);
  --card-foreground: oklch(0.985 0 0);
  --popover: oklch(0.205 0 0);
  --popover-foreground: oklch(0.985 0 0);
  --primary: oklch(0.922 0 0);
  --primary-foreground: oklch(0.205 0 0);
  --secondary: oklch(0.269 0 0);
  --secondary-foreground: oklch(0.985 0 0);
  --muted: oklch(0.269 0 0);
  --muted-foreground: oklch(0.708 0 0);
  --accent: oklch(0.269 0 0);
  --accent-foreground: oklch(0.985 0 0);
  --destructive: oklch(0.704 0.191 22.216);
  --border: oklch(1 0 0 / 10%);
  --input: oklch(1 0 0 / 15%);
  --ring: oklch(0.556 0 0);
}

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --radius-sm: calc(var(--radius) - 4px);
  --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) + 4px);
}

@layer base {
  * {
    @apply border-border outline-ring/50;
  }
  body {
    @apply bg-background text-foreground;
  }
}
```

Why this shape:

- `:root` / `.dark` hold **complete oklch color values** — not raw HSL
  triples, no `hsl()` wrapper anywhere.
- `@theme inline` maps each variable to a `--color-*` token; that mapping
  is what generates `bg-primary`, `text-muted-foreground`, `border-border`,
  etc. The `inline` keyword makes utilities reference the underlying
  variable directly, so `.dark` swaps take effect at runtime.
- Opacity modifiers work directly on full color values: `bg-primary/50`,
  `outline-ring/50` (v4 resolves them with `color-mix()`).
- `@custom-variant dark` replaces v3's `darkMode: ["class"]` config.
  Without it, `dark:` variants follow the OS media query instead of the
  `.dark` class.
- `components.json` on v4:
  `"tailwind": { "config": "", "css": "app/globals.css", "cssVariables": true }`
  — the empty config path is intentional.

The values above are the neutral base. `npx shadcn@latest init` writes the
full set, including `--chart-1..5` and the `--sidebar-*` group, in this
same pattern.

## Dark Mode Setup

### Next.js App Router (next-themes)

**1. Install:**
```bash
npm install next-themes
```

**2. Theme provider:**
```tsx
// components/theme-provider.tsx
"use client"

import * as React from "react"
import { ThemeProvider as NextThemesProvider } from "next-themes"

export function ThemeProvider({
  children,
  ...props
}: React.ComponentProps<typeof NextThemesProvider>) {
  return <NextThemesProvider {...props}>{children}</NextThemesProvider>
}
```

**3. Wrap app:**
```tsx
// app/layout.tsx
import { ThemeProvider } from "@/components/theme-provider"

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          {children}
        </ThemeProvider>
      </body>
    </html>
  )
}
```

`attribute="class"` toggles the `.dark` class that `@custom-variant dark`
and the `.dark { }` variable block respond to. Both halves must exist.

**4. Theme toggle:**
```tsx
import { Moon, Sun } from "lucide-react"
import { useTheme } from "next-themes"
import { Button } from "@/components/ui/button"

export function ThemeToggle() {
  const { setTheme, theme } = useTheme()

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => setTheme(theme === "light" ? "dark" : "light")}
    >
      <Sun className="h-[1.2rem] w-[1.2rem] rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
      <Moon className="absolute h-[1.2rem] w-[1.2rem] rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
      <span className="sr-only">Toggle theme</span>
    </Button>
  )
}
```

### Vite / Other Frameworks

next-themes works outside Next.js, or toggle the class yourself:

```javascript
// Store preference
function toggleDarkMode() {
  const isDark = document.documentElement.classList.toggle('dark')
  localStorage.setItem('theme', isDark ? 'dark' : 'light')
}

// Initialize on load (run before first paint to avoid flash)
if (localStorage.theme === 'dark' ||
    (!('theme' in localStorage) &&
     window.matchMedia('(prefers-color-scheme: dark)').matches)) {
  document.documentElement.classList.add('dark')
}
```

The CSS side is identical: `@custom-variant dark` plus the `.dark`
variable block.

## Color Customization

### Method 1: Edit the CSS Variables

Change colors by editing `:root` and `.dark` — full oklch values:

```css
:root {
  --primary: oklch(0.55 0.22 264);       /* violet */
  --primary-foreground: oklch(0.98 0.01 264);
}

.dark {
  --primary: oklch(0.65 0.2 264);
  --primary-foreground: oklch(0.15 0.05 264);
}
```

No other file changes. The `@theme inline` mapping already points
`bg-primary` at `var(--primary)`.

### Method 2: Theme Generator

https://ui.shadcn.com/themes — pick a base color, copy the generated
`:root` / `.dark` blocks over yours. Current output is oklch; if a
generator hands you raw HSL triples, it is emitting the legacy v3 format —
do not paste that into a v4 project.

### Method 3: Multiple Themes

```css
[data-theme="violet"] {
  --primary: oklch(0.55 0.22 290);
  --primary-foreground: oklch(0.98 0.01 290);
}

[data-theme="rose"] {
  --primary: oklch(0.59 0.2 15);
  --primary-foreground: oklch(0.97 0.02 15);
}
```

```tsx
<div data-theme="violet">
  <Button>Violet theme</Button>
</div>
```

### Adding a New Token

Two steps, both required:

```css
:root { --highlight: oklch(0.85 0.15 95); }
.dark { --highlight: oklch(0.6 0.12 95); }

@theme inline {
  --color-highlight: var(--highlight);   /* generates bg-highlight etc. */
}
```

A variable without its `@theme inline` line produces no utility — the
class silently does nothing.

## Component Customization

Components live in your codebase — modify directly.

### Customize Variants

```tsx
// components/ui/button.tsx
const buttonVariants = cva(
  "inline-flex items-center justify-center rounded-md text-sm font-medium",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground",
        destructive: "bg-destructive text-white",
        outline: "border border-input bg-background",
        // Add custom variant
        gradient: "bg-gradient-to-r from-purple-500 to-pink-500 text-white",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-9 rounded-md px-3",
        lg: "h-11 rounded-md px-8",
        // Add custom size
        xl: "h-14 rounded-md px-10 text-lg",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)
```

```tsx
<Button variant="gradient" size="xl">Custom Button</Button>
```

### Override with className

```tsx
<Card className="border-2 border-purple-500 shadow-2xl hover:scale-105 transition-transform">
  Custom styled card
</Card>
```

Use `className` for one-offs; add a cva variant when a customization
repeats.

## Base Color Presets

`init` offers neutral bases: **Slate**, **Gray**, **Zinc**, **Neutral**,
**Stone**. Change later by replacing the `:root` / `.dark` values.

## Style Variants

**new-york** is the current default style; the old "default" style is
deprecated for new projects. Set in `components.json`:

```json
{
  "style": "new-york",
  "tailwind": {
    "config": "",
    "css": "app/globals.css",
    "cssVariables": true
  }
}
```

## Radius Customization

One variable drives the scale:

```css
:root {
  --radius: 0.625rem;  /* default */
  /* 0rem = sharp, 1rem = rounded */
}
```

`@theme inline` derives `--radius-sm/md/lg/xl` from it, so `rounded-lg`
etc. track the single knob.

## Best Practices

1. **One convention per project**: v4 oklch + `@theme inline`, or the v3
   appendix recipe — never both
2. **Consistent foreground pairs**: every color ships with its
   `-foreground` partner
3. **Test both themes**: verify components in light and dark
4. **Semantic naming**: `destructive` not `red`, `muted` not `gray`
5. **Accessibility**: WCAG AA contrast minimum, in both themes
6. **New tokens are two lines**: variable in `:root`/`.dark` AND the
   `--color-*` mapping in `@theme inline`

## Appendix: Tailwind v3 (legacy)

Only for existing projects already on Tailwind v3. Do not use any of this
on v4.

Variables are **raw HSL triples** (no `hsl()` wrapper), defined in
`@layer base`:

```css
@layer base {
  :root {
    --background: 0 0% 100%;
    --foreground: 222.2 84% 4.9%;
    --primary: 222.2 47.4% 11.2%;
    --primary-foreground: 210 40% 98%;
    --border: 214.3 31.8% 91.4%;
    --ring: 222.2 84% 4.9%;
    --radius: 0.5rem;
    /* ...secondary, muted, accent, destructive, input... */
  }

  .dark {
    --background: 222.2 84% 4.9%;
    --foreground: 210 40% 98%;
    /* ...dark values for the same set... */
  }
}
```

`tailwind.config.ts` maps them — this `colors` block exists ONLY on v3:

```ts
export default {
  darkMode: ["class"],
  theme: {
    extend: {
      colors: {
        border: "hsl(var(--border))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        /* ...same pattern for the rest... */
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
    },
  },
}
```

Legacy differences from v4: dark mode is `darkMode: ["class"]` in the
config (no `@custom-variant`); opacity is `hsl(var(--primary) / 0.5)`;
new tokens need both the CSS variable and a config `colors` entry.
Migration guide: https://ui.shadcn.com/docs/tailwind-v4
