'use strict';
/**
 * Reads the terminal's shipped source: index.html plus every local script it
 * loads. These tests assert on behaviour ("does the page wire the screener
 * independently?"), not on file layout, so they must keep working after the
 * inline script was extracted into its own module.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

function readPage() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const sources = [html];
  for (const match of html.matchAll(/<script\s+src="([^"]+)"/g)) {
    const src = match[1];
    if (/^https?:/.test(src)) continue;
    const file = path.join(ROOT, src.replace(/^\//, ''));
    if (fs.existsSync(file)) sources.push(fs.readFileSync(file, 'utf8'));
  }
  return sources.join('\n');
}

module.exports = { readPage, ROOT };
