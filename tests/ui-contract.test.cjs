const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { TextEncoder, TextDecoder } = require('node:util');
const { JSDOM, VirtualConsole } = require('jsdom');

// DOM wiring only: no browser, layout/geometry assertions, external resources,
// network or serial devices. Snapshot the files once so concurrent design edits
// cannot make the fixtures within one run use different versions of index.html.
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const scripts = [
  'vendor/bootstrap/bootstrap.bundle.min.js',
  'js/serial-utils.js',
  'js/common.js',
].map((file) => ({ file, source: fs.readFileSync(path.join(root, file), 'utf8') }));

function nextEvent(element, name) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      element.removeEventListener(name, listener);
      reject(new Error(`Expected ${name} on #${element.id || element.nodeName}`));
    }, 2000);
    const listener = (event) => {
      clearTimeout(timeout);
      resolve(event);
    };
    element.addEventListener(name, listener, { once: true });
  });
}

async function until(predicate, description) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(`Expected ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function fixture(t) {
  const errors = [];
  const calls = { serial: 0, network: 0, worker: 0 };
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => errors.push(String(error.stack || error)));
  const dom = new JSDOM(html, {
    url: 'https://ui-contract.invalid/Web-Serial-Debug-KR/',
    runScripts: 'outside-only', // Script/link URLs in the document never load.
    pretendToBeVisual: true, // Supplies requestAnimationFrame, not a renderer.
    virtualConsole,
  });
  const { window } = dom;
  const serial = new window.EventTarget();
  serial.getPorts = async () => { calls.serial += 1; return []; };
  serial.requestPort = async () => { calls.serial += 1; throw new Error('Serial access is outside this UI test'); };
  Object.defineProperty(window.navigator, 'serial', { value: serial });
  Object.defineProperty(window, 'isSecureContext', { value: true });
  window.TextEncoder = TextEncoder;
  window.TextDecoder = TextDecoder;
  window.structuredClone = (value) => window.JSON.parse(window.JSON.stringify(value));
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.alert = (message) => { errors.push(`Unexpected alert: ${message}`); };
  window.confirm = () => false;
  window.fetch = () => { calls.network += 1; throw new Error('Network access is outside this UI test'); };
  window.XMLHttpRequest = class {
    constructor() { calls.network += 1; throw new Error('Network access is outside this UI test'); }
  };
  window.Worker = class {
    constructor() { calls.worker += 1; throw new Error('Worker execution is outside this UI test'); }
  };
  window.addEventListener('error', (event) => { errors.push(String(event.error || event.message)); event.preventDefault(); });
  window.addEventListener('unhandledrejection', (event) => { errors.push(String(event.reason)); event.preventDefault(); });
  t.after(() => {
    window.dispatchEvent(new window.Event('pagehide'));
    window.close();
    assert.deepEqual(errors, [], 'UI actions must not produce uncaught errors');
    assert.deepEqual(calls, { serial: 0, network: 0, worker: 0 }, 'UI controls must not start device, network or script activity');
  });

  const ready = window.document.readyState === 'loading'
    ? nextEvent(window.document, 'DOMContentLoaded') : Promise.resolve();
  for (const script of scripts) window.eval(`${script.source}\n//# sourceURL=${script.file}`);
  await ready;
  assert.equal(typeof window.bootstrap.Tab, 'function', 'Use the actual locally bundled Bootstrap Tab');
  assert.equal(typeof window.bootstrap.Modal, 'function', 'Use the actual locally bundled Bootstrap Modal');
  const byId = (id) => {
    const element = window.document.getElementById(id);
    assert.ok(element, `Required control #${id} exists`);
    return element;
  };
  return { window, document: window.document, byId };
}

test('local Bootstrap switches all tool tabs and keeps panel targets and ARIA selection in sync', async (t) => {
  const { window, byId } = await fixture(t);
  const tabs = ['nav-funsr', 'nav-quick-send', 'nav-options', 'nav-code'].map((id) => ({
    button: byId(`${id}-tab`), panel: byId(id),
  }));
  for (const { button, panel } of tabs) {
    assert.equal(button.getAttribute('data-bs-toggle'), 'tab');
    assert.equal(button.getAttribute('data-bs-target'), `#${panel.id}`);
    assert.equal(button.getAttribute('aria-controls'), panel.id);
    assert.equal(panel.getAttribute('role'), 'tabpanel');
    assert.equal(panel.getAttribute('aria-labelledby'), button.id);
    assert.ok((button.getAttribute('aria-label') || button.textContent).trim(), 'Tab has an accessible name');
  }
  // Speed is the new default; the original three tabs and their accessible
  // Bootstrap targets are preserved independently of heading/body placement.
  assert.equal(tabs.filter(({ button }) => button.classList.contains('active')).length, 1);
  assert.equal(tabs[0].button.classList.contains('active'), true);
  assert.equal(tabs[0].panel.classList.contains('show'), true);
  const initialIndex = tabs.findIndex(({ button }) => button.classList.contains('active'));
  const cycle = [1, 2, 3, 4].map((offset) => tabs[(initialIndex + offset) % tabs.length]);
  for (const selected of cycle) {
    const shown = nextEvent(selected.button, 'shown.bs.tab');
    selected.button.click();
    await shown;
    await until(() => tabs.every(({ panel }) => panel.classList.contains('show') === (panel === selected.panel)), 'only the selected Bootstrap pane to be shown');
    assert.ok(window.bootstrap.Tab.getInstance(selected.button));
    for (const { button, panel } of tabs) {
      const active = button === selected.button;
      assert.equal(button.getAttribute('role'), 'tab');
      assert.equal(button.getAttribute('aria-selected'), String(active));
      assert.equal(button.classList.contains('active'), active);
      assert.equal(panel.classList.contains('active'), active);
      assert.equal(panel.classList.contains('show'), active);
      if (!active) assert.equal(button.getAttribute('tabindex'), '-1');
      else assert.notEqual(button.getAttribute('tabindex'), '-1');
    }
  }
});

test('local Bootstrap opens and dismisses the help modal through its existing controls', async (t) => {
  const { window, document, byId } = await fixture(t);
  const help = byId('model-help');
  const trigger = document.querySelector('[data-bs-toggle="modal"][data-bs-target="#model-help"]');
  assert.ok(trigger, 'Help trigger targets the help dialog');
  const titleId = help.getAttribute('aria-labelledby');
  assert.ok(titleId && byId(titleId).textContent.trim(), 'Dialog has an accessible title');
  const shown = nextEvent(help, 'shown.bs.modal');
  trigger.click();
  await shown;
  assert.ok(window.bootstrap.Modal.getInstance(help));
  assert.equal(help.classList.contains('show'), true);
  assert.equal(help.hidden, false);
  assert.equal(help.getAttribute('aria-modal'), 'true');
  assert.equal(help.getAttribute('role'), 'dialog');
  assert.notEqual(help.getAttribute('aria-hidden'), 'true');
  assert.equal(document.body.classList.contains('modal-open'), true);
  assert.equal(document.querySelectorAll('.modal-backdrop').length, 1);

  const dismiss = help.querySelector('[data-bs-dismiss="modal"]');
  assert.ok(dismiss, 'Help dialog has a Bootstrap dismiss control');
  const hidden = nextEvent(help, 'hidden.bs.modal');
  dismiss.click();
  await hidden;
  assert.equal(help.classList.contains('show'), false);
  assert.equal(help.getAttribute('aria-hidden'), 'true');
  assert.equal(help.hasAttribute('aria-modal'), false);
  assert.equal(document.body.classList.contains('modal-open'), false);
  assert.equal(document.querySelectorAll('.modal-backdrop').length, 0);
});

test('each sidebar toggle closes and reopens only its own panel and stays outside the collapsed content', async (t) => {
  const { byId } = await fixture(t);
  const controls = ['serial-options', 'serial-tools'].map((id) => {
    const sidebar = byId(id);
    const button = sidebar.querySelector('.toggle-button');
    assert.ok(button, `#${id} has a collapse toggle`);
    const targetId = button.getAttribute('aria-controls');
    const panel = targetId ? byId(targetId) : sidebar.querySelector('.collapse');
    assert.ok(panel && sidebar.contains(panel), `#${id} controls its own collapsible panel`);
    assert.ok(!panel.contains(button), 'The toggle must remain outside the content it hides');
    assert.ok((button.getAttribute('aria-label') || button.textContent || button.title).trim(), 'Toggle has an accessible name');
    return { button, panel };
  });
  const assertToggleAvailable = (button) => {
    assert.equal(button.isConnected, true);
    assert.equal(button.disabled, false);
    assert.equal(button.hidden, false);
    assert.equal(button.closest('[hidden], .collapse:not(.show)'), null, 'Toggle is not nested in hidden/collapsed content');
  };
  for (const { button, panel } of controls) {
    assertToggleAvailable(button);
    if (!panel.classList.contains('show')) button.click();
    await until(() => panel.classList.contains('show'), 'sidebar initially opened through its toggle');
  }
  for (const selected of controls) {
    const other = controls.find((item) => item !== selected);
    selected.button.click();
    await until(() => !selected.panel.classList.contains('show'), 'selected sidebar collapsed');
    assert.equal(selected.button.getAttribute('aria-expanded'), 'false');
    assert.equal(other.panel.classList.contains('show'), true, 'Other sidebar remains open');
    controls.forEach(({ button }) => assertToggleAvailable(button));
    selected.button.click();
    await until(() => selected.panel.classList.contains('show'), 'selected sidebar reopened');
    assert.equal(selected.button.getAttribute('aria-expanded'), 'true');
    assert.equal(selected.panel.hidden, false);
    assert.equal(other.panel.classList.contains('show'), true);
    controls.forEach(({ button }) => assertToggleAvailable(button));
  }
});

test('FUNSR speed controls expose the documented draft range and explicit apply contract with no demo surface', async (t) => {
  const { document, byId } = await fixture(t);
  assert.equal(document.getElementById('serial-demo'), null);
  assert.equal(document.getElementById('demo-banner'), null);
  for (const [id, type] of [['funsr-speed-range', 'range'], ['funsr-speed-value', 'number']]) {
    const input = byId(id);
    assert.equal(input.type, type);
    assert.equal(input.min, '0.5');
    assert.equal(input.max, '5');
    assert.equal(input.step, '0.1');
    assert.equal(Number(input.value), 1.2);
    assert.ok(input.labels.length || input.getAttribute('aria-label')?.trim(), `${id} has an accessible label`);
  }
  for (const id of ['funsr-speed-decrease', 'funsr-speed-increase', 'funsr-speed-minimum', 'funsr-speed-default', 'funsr-speed-maximum', 'funsr-speed-apply']) {
    assert.equal(byId(id).type, 'button', 'Draft controls must not accidentally submit a form');
  }
  assert.equal(byId('funsr-speed-command').textContent.trim(), 'DKP1.2');
  assert.equal(byId('funsr-device-confirm').type, 'checkbox');
  assert.equal(byId('funsr-device-confirm').checked, false);
  assert.equal(byId('funsr-speed-apply').disabled, true);
  assert.equal(byId('funsr-speed-status').getAttribute('role'), 'status');
  assert.equal(byId('funsr-speed-status').getAttribute('aria-live'), 'polite');
  assert.match(byId('funsr-speed-reported').textContent, /아직 확인하지 않음/);
});
