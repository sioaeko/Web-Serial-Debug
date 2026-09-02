'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

// Source-level color regression only; this is not browser or rendered UI QA.
const css = fs.readFileSync(path.join(__dirname, '../css/style.css'), 'utf8');
const tokens = (block) => Object.fromEntries([...block.matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-f]{6})\s*;/gi)]
  .map((match) => [match[1], match[2]]));
const light = tokens(css.match(/:root\s*\{([^}]+)\}/)[1]);
const dark = { ...light, ...tokens(css.match(/\[data-theme="dark"\]\s*\{([^}]+)\}/)[1]) };
const hintStyle = css.match(/\.send-button kbd\s*\{([^}]+)\}/)[1];
const hintOpacity = Number(hintStyle.match(/opacity:\s*([\d.]+)/)?.[1] || 1);

function rgb(hex) {
  assert.match(hex || '', /^#[0-9a-f]{6}$/i, 'A tested color token must be an opaque sRGB hex color');
  return [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255);
}

function luminance(color) {
  const [red, green, blue] = color.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(first, second) {
  const a = luminance(first), b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

for (const [theme, values] of Object.entries({ light, dark })) {
  test(`${theme} primary buttons and keyboard hints meet text contrast in default, hover and active states`, () => {
    assert.match(hintStyle, /(?:^|;)\s*color:\s*inherit\s*;/);
    assert.match(hintStyle, /(?:^|;)\s*background:\s*transparent\s*;/);
    assert.ok(Number.isFinite(hintOpacity) && hintOpacity >= 0 && hintOpacity <= 1);
    const foreground = rgb(values['--btn-primary-color']);
    for (const [state, token] of [
      ['default', '--btn-primary-bg'],
      ['hover', '--btn-primary-hover-bg'],
      ['active', '--btn-primary-active-bg'],
    ]) {
      const background = rgb(values[token]);
      const hint = foreground.map((channel, index) => channel * hintOpacity + background[index] * (1 - hintOpacity));
      for (const [role, color] of [['button text', foreground], ['keyboard hint', hint]]) {
        const ratio = contrast(color, background);
        // Compare the unrounded value: 4.499 must not pass as 4.50.
        assert.ok(ratio >= 4.5, `${theme} ${state} ${role}: ${ratio.toFixed(3)}:1 is below 4.5:1 (${token})`);
      }
    }
  });
}
