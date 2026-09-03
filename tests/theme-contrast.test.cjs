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

const neutralTokens = [
  '--app-bg', '--surface', '--surface-soft', '--surface-hover', '--surface-active',
  '--text', '--muted', '--subtle', '--border', '--border-strong',
  '--accent', '--accent-hover', '--accent-soft', '--accent-contrast', '--focus',
  '--selection-bg', '--selection-color', '--checked-bg', '--checked-border',
  '--btn-primary-bg', '--btn-primary-color', '--btn-primary-hover-bg', '--btn-primary-active-bg',
  '--terminal-bg', '--terminal-grid',
];
const semanticPairs = [
  ['body text', '--text', '--surface', 4.5],
  ['helper text', '--muted', '--surface-soft', 4.5],
  ['placeholder text', '--subtle', '--surface', 4.5],
  ['timestamps', '--subtle', '--terminal-bg', 4.5],
  ['command preview', '--text', '--surface-soft', 4.5],
  ['selected control', '--accent', '--accent-soft', 4.5],
  ['text selection', '--selection-color', '--selection-bg', 4.5],
  ['focus outline', '--focus', '--surface', 3],
  ['input boundary', '--border-strong', '--surface', 3],
  ['slider thumb', '--accent', '--border-strong', 3],
  ['checkbox boundary', '--checked-border', '--surface', 3],
  ['checkbox checkmark', '#ffffff', '--checked-bg', 3],
  ['RX and connected state', '--success', '--success-soft', 4.5],
  ['TX label', '--tx', '--tx-soft', 4.5],
  ['warning', '--warning', '--warning-soft', 4.5],
  ['error', '--danger', '--danger-soft', 4.5],
];

for (const [theme, values] of Object.entries({ light, dark })) {
  test(`${theme} controls are neutral while device traffic and status retain semantic colors`, () => {
    for (const token of neutralTokens) {
      const [red, green, blue] = rgb(values[token]);
      assert.ok(red === green && green === blue, `${theme} ${token} must not tint the control surface`);
    }
    for (const token of ['--success', '--tx', '--warning', '--danger']) {
      const channels = rgb(values[token]);
      assert.ok(Math.max(...channels) - Math.min(...channels) > 0.1, `${token} retains a distinct signal color`);
    }
    assert.notEqual(values['--tx'], values['--accent'], 'TX must not reuse the general control emphasis');
  });

  test(`${theme} neutral surfaces, keyboard focus and semantic signals retain contrast`, () => {
    const color = (token) => rgb(token.startsWith('#') ? token : values[token]);
    for (const [role, foreground, background, minimum] of semanticPairs) {
      const ratio = contrast(color(foreground), color(background));
      assert.ok(ratio >= minimum, `${theme} ${role}: ${ratio.toFixed(3)}:1 is below ${minimum}:1`);
    }
  });

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

test('control styling and signal colors are wired separately, including Bootstrap focus states', () => {
  const block = (selector) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = css.match(new RegExp(escaped + '\\s*\\{([^}]+)\\}'));
    assert.ok(match, `Missing selector: ${selector}`);
    return match[1];
  };
  const primary = block('.btn-primary');
  for (const state of ['hover', 'active', 'disabled']) {
    assert.ok(primary.includes(`--bs-btn-${state}-color: var(--btn-primary-color)`), `${state} text must follow the theme foreground`);
  }
  assert.match(block('.form-check-input:checked'), /background-color:\s*var\(--checked-bg\)/);
  assert.match(block('.log-entry[data-direction="tx"] .log-direction'), /color:\s*var\(--tx\)/);
  assert.match(block('.log-entry[data-direction="rx"] .log-direction'), /color:\s*var\(--success\)/);
  assert.match(block('.traffic-stats > span:nth-child(2) > .bi'), /color:\s*var\(--tx\)/);
  assert.match(block('.funsr-command-text'), /background:\s*transparent/);
  assert.match(block('.funsr-command-text'), /color:\s*var\(--text\)/);
  assert.match(block('.quick-item .quick-send'), /background:\s*var\(--surface\)/);
  assert.match(block('a:not(.btn):not(.skip-link)'), /text-decoration:\s*underline/);
});
