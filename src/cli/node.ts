// SPDX-License-Identifier: BSD-3-Clause

/**
 * Node.js adapters for weasyprint-ts: font discovery (system/font-directory
 * scanning with an index cache) and URL fetching (file:// and http(s)).
 *
 * Import from `weasyprint-ts/node` — the root entry stays runtime-agnostic.
 */
export { createFontConfiguration, defaultFontDirs, scanFontDirectories } from './node_fonts.ts';
export { NodeFetcher } from './node_fetcher.ts';
