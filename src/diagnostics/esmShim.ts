/**
 * ESM-safe shims for `require()` and `__dirname` / `__filename`.
 *
 * ## Why this file exists
 *
 * SERA's package.json declares `"type": "module"`. When the dev server runs
 * via `tsx server.ts`, every TypeScript file is executed as native ESM.
 * In ESM:
 *   - The CommonJS `require()` function is NOT defined.
 *   - The CommonJS globals `__dirname` and `__filename` are NOT defined.
 *
 * Several diagnostic checks and WindowsProviders need to dynamically load
 * native Node addons (robotjs, koffi, win32-api) that are themselves
 * CommonJS modules. They historically called `require('robotjs')` directly,
 * which threw `ReferenceError: require is not defined` under tsx — silently
 * caught by try/catch and reported as "robotjs native module failed to
 * load: require is not defined" in the diagnostics panel. This made the
 * whole diagnostic system look broken even though robotjs was perfectly
 * healthy.
 *
 * The fix is Node's official ESM escape hatch: `module.createRequire()`
 * builds a `require` function that resolves modules relative to a given
 * URL (typically `import.meta.url`). The same trick gives us
 * `__dirname` / `__filename` via `fileURLToPath`.
 *
 * The same source files are also bundled by `esbuild --format=cjs` into
 * `dist/server.cjs`, which runs as CommonJS. There, `__dirname`,
 * `__filename`, and `require` are real globals. The shims below detect
 * which runtime they're in and fall back to the native globals when
 * available — so the same code works in both `dev` and `start` modes.
 *
 * This pattern is copied from `src/actions/WindowExecutor.ts:1-29`,
 * which already handles both modes correctly. Centralising it here means
 * every diagnostic check (and WindowsProviders) can use the same shim
 * instead of duplicating the workaround in five places.
 */

import { createRequire as nodeCreateRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { backendBundlePath } from '../local/SERAPaths';

/**
 * The URL of this module file. Used as the resolution base for the
 * shimmed `require` so that bare module specifiers (e.g. 'robotjs')
 * resolve relative to the project's node_modules — same as they would
 * in the original CommonJS layout.
 *
 * `import.meta.url` is available in ESM. In bundled CJS, esbuild provides
 * a shim, so this also works there (the value will be a file:// URL
 * pointing at dist/server.cjs).
 */
const moduleUrl: string =
  typeof import.meta !== 'undefined' &&
  typeof (import.meta as { url?: unknown }).url === 'string'
    ? (import.meta as { url: string }).url
    : `file://${backendBundlePath()}`;

/**
 * `__filename`-equivalent. In native CommonJS, `__filename` is defined
 * by the runtime; we detect that and use it directly to avoid any
 * file-URL round-trip overhead.
 */
export const esmFilename: string =
  typeof (globalThis as { __filename?: string }).__filename === 'string' &&
  (globalThis as { __filename?: string }).__filename
    ? (globalThis as { __filename?: string }).__filename as string
    : fileURLToPath(moduleUrl);

/**
 * `__dirname`-equivalent. Same fallback strategy as `esmFilename`.
 */
export const esmDirname: string =
  typeof (globalThis as { __dirname?: string }).__dirname === 'string' &&
  (globalThis as { __dirname?: string }).__dirname
    ? (globalThis as { __dirname?: string }).__dirname as string
    : dirname(esmFilename);

/**
 * A `require` function that works in both ESM (via `createRequire`) and
 * CommonJS (native global). Use this anywhere a diagnostic check needs
 * to dynamically load a CommonJS-only native addon (robotjs, koffi,
 * win32-api, screenshot-desktop, etc.).
 *
 * Example:
 * ```ts
 * import { esmRequire } from './esmShim';
 * try {
 *   const robot = esmRequire('robotjs');
 *   // probe robot.getMousePos() ...
 * } catch (err) {
 *   // surface the real underlying error, not "require is not defined"
 * }
 * ```
 */
export const esmRequire: NodeRequire =
  typeof (globalThis as { require?: NodeRequire }).require === 'function'
    ? (globalThis as { require?: NodeRequire }).require as NodeRequire
    : nodeCreateRequire(moduleUrl);

/**
 * Dynamically imports a module via the standard ESM `import()`
 * expression. This is the ESM-native way to do dynamic imports and is
 * already safe in both ESM and CJS contexts — but centralising the
 * helper here makes it easy for diagnostic checks to opt for dynamic
 * `import()` instead of `require()` when loading packages that ship
 * proper ESM entry points (e.g. 'playwright', 'active-win').
 *
 * Returned as a typed alias so callers don't need to repeat the cast.
 */
export const esmImport: (specifier: string) => Promise<unknown> =
  (specifier: string) => import(specifier);
