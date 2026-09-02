const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { TextEncoder, TextDecoder } = require('node:util');
const { ReadableStream, WritableStream } = require('node:stream/web');
const { JSDOM, VirtualConsole } = require('jsdom');
const { DEFAULT_SERIAL_OPTIONS, DEFAULT_TOOL_OPTIONS } = require('../js/serial-utils.js');

// These are DOM integration tests, not browser or physical-device tests. External
// scripts/resources never load. Only the real application scripts run, with UI
// library adapters and an in-memory Web Serial port built on native Web Streams.
const ROOT = path.resolve(__dirname, '..');
const CONFIG_KEY = 'web-serial-debug-kr:config:v1';
const HISTORY_KEY = 'web-serial-debug-kr:history:v1';
const encoder = new TextEncoder();
const sleep = (milliseconds = 30) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function until(predicate, description, timeout = 2500) {
  const deadline = Date.now() + timeout;
  do {
    const result = predicate();
    if (result) return result;
    await sleep(5);
  } while (Date.now() < deadline);
  assert.fail(`Timed out: ${description}`);
}

function savedConfig(toolOptions = {}, overrides = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    serialOptions: { ...DEFAULT_SERIAL_OPTIONS },
    toolOptions: { ...DEFAULT_TOOL_OPTIONS, ...toolOptions },
    quickSendList: [{ name: '명령 그룹', list: [{ name: '응답 확인', content: 'AT', hex: false }] }],
    code: '// 이 코드는 실행 버튼을 누르기 전에는 실행되지 않습니다.',
    ...overrides,
  });
}

function fakePort(window, index) {
  const calls = { open: 0, close: 0, cancel: 0, canceled: 0, write: 0, writerAcquire: 0, writerRelease: 0 };
  const port = {
    calls,
    writes: [],
    attempts: [],
    openOptions: [],
    readable: null,
    writable: null,
    controller: null,
    isOpen: false,
    rejectWrite: null,
    gates: {},
    getInfo() { return { usbVendorId: 0x10c4, usbProductId: 0xea60 + index }; },
    async open(options) {
      calls.open += 1;
      port.openOptions.push(JSON.parse(JSON.stringify(options)));
      if (port.gates.open) await port.gates.open.promise;
      if (port.isOpen) throw new window.DOMException('Port is already open', 'InvalidStateError');
      port.isOpen = true;
      port.readable = new ReadableStream({
        start(controller) { port.controller = controller; },
        async cancel() {
          calls.cancel += 1;
          if (port.gates.cancel) await port.gates.cancel.promise;
          calls.canceled += 1;
        },
      });
      port.writable = new WritableStream({
        async write(bytes) {
          calls.write += 1;
          port.attempts.push(Uint8Array.from(bytes));
          if (port.gates.write) await port.gates.write.promise;
          if (port.rejectWrite) {
            const error = port.rejectWrite;
            port.rejectWrite = null;
            throw error;
          }
          port.writes.push(Uint8Array.from(bytes));
        },
      });
      const getWriter = port.writable.getWriter.bind(port.writable);
      port.writable.getWriter = () => {
        calls.writerAcquire += 1;
        const writer = getWriter();
        const release = writer.releaseLock.bind(writer);
        writer.releaseLock = () => { calls.writerRelease += 1; release(); };
        return writer;
      };
    },
    async close() {
      calls.close += 1;
      if (port.readable?.locked || port.writable?.locked) {
        throw new window.DOMException('Cannot close locked streams', 'InvalidStateError');
      }
      if (port.gates.close) await port.gates.close.promise;
      port.isOpen = false;
      port.readable = null;
      port.writable = null;
      port.controller = null;
    },
    receive(bytes) {
      if (!port.controller) throw new Error('Test port is not open');
      port.controller.enqueue(Uint8Array.from(bytes));
    },
    releaseGates() { for (const gate of Object.values(port.gates)) gate.resolve(); },
    finishReading() {
      try { port.controller?.close(); } catch { /* Stream may already have been canceled. */ }
    },
  };
  return port;
}

function installLibraryAdapters(window, calls) {
  class Modal {
    constructor(element) { this.element = typeof element === 'string' ? window.document.querySelector(element) : element; }
    show() {
      calls.modals += 1;
      this.element.classList.add('show');
      this.element.dispatchEvent(new window.Event('shown.bs.modal'));
    }
    hide() {
      this.element.classList.remove('show');
      this.element.dispatchEvent(new window.Event('hidden.bs.modal'));
    }
  }
  window.bootstrap = { Modal };
  window.CodeMirror = {
    fromTextArea(textarea) {
      const listeners = new Map();
      const wrapper = window.document.createElement('div');
      wrapper.className = 'CodeMirror';
      textarea.after(wrapper);
      const editor = {
        getValue: () => textarea.value,
        setValue(value) {
          textarea.value = String(value);
          for (const listener of listeners.get('change') || []) listener(editor);
        },
        on(type, listener) {
          if (!listeners.has(type)) listeners.set(type, []);
          listeners.get(type).push(listener);
        },
        setOption() {},
        getWrapperElement: () => wrapper,
        refresh() {},
        focus: () => textarea.focus(),
      };
      return editor;
    },
  };
}

async function runtime(t, { supported = true, secure = true, storage = {} } = {}) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => errors.push(error));
  const dom = new JSDOM(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'), {
    url: 'https://serial-test.example/Web-Serial-Debug-KR/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole,
  });
  const { window } = dom;
  const calls = { requestPort: 0, getPorts: 0, worker: 0, workerTerminated: 0, modals: 0, alerts: [], confirms: [] };
  const workers = [];
  const ports = [fakePort(window, 0), fakePort(window, 1)];
  const serial = new window.EventTarget();
  serial.nextPort = ports[0];
  serial.getPorts = async () => { calls.getPorts += 1; return ports; };
  serial.requestPort = async () => { calls.requestPort += 1; return serial.nextPort; };
  serial.emit = (type, port) => {
    // Real navigator.serial receives bubbled events whose target is SerialPort.
    const event = new window.Event(type);
    Object.defineProperties(event, { target: { value: port }, port: { value: port } });
    serial.dispatchEvent(event);
  };
  Object.defineProperty(window, 'isSecureContext', { value: secure });
  if (supported) Object.defineProperty(window.navigator, 'serial', { value: serial });
  window.TextEncoder = TextEncoder;
  window.TextDecoder = TextDecoder;
  // The app clones JSON-compatible settings. Keep clones in the window realm,
  // as the browser's structuredClone does, rather than leaking Node prototypes.
  window.structuredClone = (value) => window.JSON.parse(window.JSON.stringify(value));
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.alert = (message) => { calls.alerts.push(String(message)); };
  window.confirm = (message) => { calls.confirms.push(String(message)); return true; };
  window.Worker = class {
    constructor() { calls.worker += 1; workers.push(this); }
    postMessage() {}
    terminate() { calls.workerTerminated += 1; }
  };
  window.URL.createObjectURL = () => 'blob:runtime-test';
  window.URL.revokeObjectURL = () => {};
  Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async () => {} } });
  window.addEventListener('error', (event) => { errors.push(event.error || event.message); event.preventDefault(); });
  window.addEventListener('unhandledrejection', (event) => { errors.push(event.reason); event.preventDefault(); });
  installLibraryAdapters(window, calls);
  for (const [key, value] of Object.entries(storage)) window.localStorage.setItem(key, value);

  const $ = (id) => {
    const element = window.document.getElementById(id);
    assert.ok(element, `DOM fixture contains #${id}`);
    return element;
  };
  const env = {
    window, dom, $, serial, ports, port: ports[0], calls, workers, errors,
    click(id, force = false) {
      if (force) $(id).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      else $(id).click();
    },
    value(id, value, event = 'change') {
      $(id).value = String(value);
      $(id).dispatchEvent(new window.Event(event, { bubbles: true }));
    },
    check(id, checked) {
      $(id).checked = checked;
      $(id).dispatchEvent(new window.Event('change', { bubbles: true }));
    },
    file(id, contents, name = 'settings.json') {
      const file = new window.File([contents], name, { type: 'application/json' });
      // jsdom FileReader works; File.text is supplied for the newer browser API.
      file.text = async () => contents;
      Object.defineProperty($(id), 'files', { value: [file], configurable: true });
      $(id).dispatchEvent(new window.Event('change', { bubbles: true }));
    },
    rows(direction) { return [...$('serial-logs').querySelectorAll(direction ? `.log-entry[data-direction="${direction}"]` : '.log-entry')]; },
    texts(direction) { return env.rows(direction).map((row) => row.querySelector('.log-body').textContent).join(''); },
  };
  t.after(async () => {
    for (const port of ports) port.releaseGates();
    if (env.$('serial-status').dataset.state === 'connected') env.click('serial-open-or-close');
    for (const port of ports) port.finishReading();
    await sleep(30);
    window.close();
    assert.deepEqual(errors.map((error) => String(error?.stack || error)), [], 'No uncaught runtime or jsdom errors');
  });
  window.eval(fs.readFileSync(path.join(ROOT, 'js/serial-utils.js'), 'utf8') + '\n//# sourceURL=serial-utils.js');
  window.eval(fs.readFileSync(path.join(ROOT, 'js/common.js'), 'utf8') + '\n//# sourceURL=common.js');
  await sleep(35);
  return env;
}

async function selectAndOpen(env) {
  env.click('serial-select-port');
  await until(() => env.$('serial-status').dataset.state === 'selected', 'port selected');
  assert.equal(env.calls.requestPort, 1);
  env.click('serial-open-or-close');
  await until(() => env.$('serial-status').dataset.state === 'connected', 'port opened');
  assert.equal(env.port.calls.open, 1);
}

async function send(env, content) {
  const previous = env.port.calls.write;
  env.value('serial-send-content', content, 'input');
  env.click('serial-send');
  await until(() => env.port.calls.write > previous, 'write attempted');
  await sleep(20);
}

const funsrState = (env) => env.$('funsr-speed-status').dataset.state;
const dkpWrites = (env) => env.port.writes.filter((bytes) => new TextDecoder().decode(bytes).startsWith('DKP'));

async function requestFunsr(env, value = 4.6) {
  env.value('funsr-speed-value', value, 'input');
  env.check('funsr-device-confirm', true);
  const previous = env.port.writes.length;
  env.click('funsr-speed-apply');
  await until(() => env.port.writes.length === previous + 1, 'explicit DKP write completed');
  await until(() => funsrState(env) === 'waiting', 'host write is awaiting a device ACK');
}

test('startup never enumerates, opens or writes remembered ports, even with saved repeat/reconnect flags', async (t) => {
  const env = await runtime(t, { storage: {
    [CONFIG_KEY]: savedConfig({ loopSend: true, loopSendTime: 100, sendContent: 'AT+RST', autoReconnect: true }),
    [HISTORY_KEY]: JSON.stringify([{ content: 'AT', hex: false, lineEnding: 'none', time: '2026-09-02T00:00:00.000Z' }]),
  } });
  await sleep(160);
  assert.equal(env.calls.getPorts, 0);
  assert.equal(env.calls.requestPort, 0);
  assert.equal(env.calls.worker, 0);
  assert.equal(env.port.calls.open, 0);
  assert.equal(env.port.calls.write, 0);
  assert.equal(env.$('serial-loop-send').checked, false);
  assert.equal(env.$('serial-auto-reconnect').checked, true);
  assert.equal(env.$('serial-send-content').value, 'AT+RST');
  assert.equal(env.$('serial-send').disabled, true);
});

test('unsupported browsers report the limitation without devices, synthetic traffic or uncaught errors', async (t) => {
  const env = await runtime(t, { supported: false });
  assert.equal(env.$('serial-select-port').disabled, true);
  assert.equal(env.$('serial-open-or-close').disabled, true);
  assert.match(env.$('serial-status').textContent, /Chrome|Edge|지원/);
  assert.equal(env.window.document.getElementById('serial-demo'), null);
  assert.equal(env.window.document.getElementById('demo-banner'), null);
  assert.equal(env.$('funsr-speed-apply').disabled, true);
  assert.equal(env.rows('rx').length, 0);
  assert.equal(env.rows('tx').length, 0);
  assert.equal(env.calls.getPorts, 0);
  assert.equal(env.calls.requestPort, 0);
  assert.equal(env.port.calls.open, 0);
  assert.equal(env.port.calls.write, 0);
  assert.equal(env.$('serial-select-port').disabled, true);
});

test('insecure pages cannot access serial ports or apply FUNSR settings', async (t) => {
  const env = await runtime(t, { secure: false });
  assert.match(env.$('serial-status').textContent, /HTTPS|localhost/);
  env.click('serial-select-port', true);
  assert.equal(env.calls.requestPort, 0);
  env.check('funsr-device-confirm', true);
  env.click('funsr-speed-apply', true);
  assert.equal(env.$('funsr-speed-apply').disabled, true);
  assert.equal(env.calls.getPorts, 0);
  assert.equal(env.port.calls.open, 0);
  assert.equal(env.port.calls.write, 0);
});

test('explicit connect sends exact UTF-8 plus CRLF and closes only after read cancellation finishes', async (t) => {
  const env = await runtime(t);
  await selectAndOpen(env);
  assert.deepEqual(env.port.openOptions[0], DEFAULT_SERIAL_OPTIONS);
  assert.equal(env.$('serial-select-port').disabled, true);
  assert.equal(env.$('serial-baud').disabled, true);
  env.value('serial-line-ending', 'crlf');
  await send(env, '한글');
  assert.deepEqual(env.port.writes[0], Uint8Array.from([...encoder.encode('한글'), 13, 10]));
  assert.equal(env.port.writable.locked, false);
  assert.equal(env.port.calls.writerAcquire, env.port.calls.writerRelease);
  const readable = env.port.readable;
  const writable = env.port.writable;
  const canceled = deferred();
  env.port.gates.cancel = canceled;
  env.click('serial-open-or-close');
  await until(() => env.port.calls.cancel === 1, 'read cancellation requested');
  assert.equal(env.port.calls.close, 0, 'port.close must await reader.cancel');
  assert.equal(env.$('serial-open-or-close').disabled, true);
  canceled.resolve();
  await until(() => env.port.calls.close === 1 && !env.port.isOpen, 'port closed after cancellation');
  assert.equal(readable.locked, false);
  assert.equal(writable.locked, false);
  await until(() => env.$('serial-status').dataset.state === 'selected', 'disconnected UI restored');
  assert.equal(env.$('serial-select-port').disabled, false);
});

test('connected port selection remains guarded even for programmatically dispatched clicks', async (t) => {
  const env = await runtime(t);
  await selectAndOpen(env);
  env.serial.nextPort = env.ports[1];
  env.click('serial-select-port', true);
  await sleep(35);
  assert.equal(env.calls.requestPort, 1);
  assert.equal(env.ports[1].calls.open, 0);
  assert.equal(env.$('serial-status').dataset.state, 'connected');
});

test('pending connection prevents replacement and duplicate open', async (t) => {
  const env = await runtime(t);
  env.click('serial-select-port');
  await until(() => env.$('serial-status').dataset.state === 'selected', 'port selected');
  const opening = deferred();
  env.port.gates.open = opening;
  env.click('serial-open-or-close');
  await until(() => env.port.calls.open === 1, 'port open pending');
  env.serial.nextPort = env.ports[1];
  env.click('serial-select-port', true);
  env.click('serial-open-or-close', true);
  assert.equal(env.calls.requestPort, 1);
  assert.equal(env.port.calls.open, 1);
  assert.equal(env.ports[1].calls.open, 0);
  opening.resolve();
  await until(() => env.$('serial-status').dataset.state === 'connected', 'pending connection finished');
});

test('disconnect waits for an in-flight write and cancels queued commands before closing', async (t) => {
  const env = await runtime(t);
  await selectAndOpen(env);
  const writing = deferred();
  env.port.gates.write = writing;
  const command = env.$('serial-quick-send-content').querySelector('.quick-send');
  command.click();
  await until(() => env.port.calls.write === 1, 'first write pending');
  command.click();
  command.click();
  const writable = env.port.writable;
  env.click('serial-open-or-close');
  await until(() => env.port.calls.cancel === 1, 'disconnect read cancellation started');
  assert.equal(env.port.calls.close, 0);
  assert.equal(writable.locked, true, 'pending write still owns its lock');
  writing.resolve();
  await until(() => env.port.calls.close === 1 && !env.port.isOpen, 'write and disconnect settled');
  assert.equal(env.port.calls.write, 1, 'queued commands must not reach the device after disconnect');
  assert.equal(env.port.calls.writerAcquire, 1);
  assert.equal(env.port.calls.writerRelease, 1);
  assert.equal(writable.locked, false);
});

test('invalid HEX sends no partial data; valid HEX remains raw despite the text line-ending setting', async (t) => {
  const env = await runtime(t);
  await selectAndOpen(env);
  env.value('serial-line-ending', 'crlf');
  env.check('serial-hex-send', true);
  for (const content of ['48GG', '1 23', '48,,65', '0x4']) {
    env.value('serial-send-content', content, 'input');
    env.click('serial-send', true);
    await sleep(10);
  }
  assert.equal(env.port.calls.write, 0);
  await send(env, '0x48, 0x69');
  assert.deepEqual(env.port.writes[0], Uint8Array.of(0x48, 0x69));
});

test('Korean RX is decoded across packets independently of interleaved UTF-8 TX', async (t) => {
  const env = await runtime(t, { storage: { [CONFIG_KEY]: savedConfig({ timeOut: 0 }) } });
  await selectAndOpen(env);
  env.click('serial-clear');
  env.port.receive([0xed, 0x95]);
  await sleep(30);
  await send(env, '전송');
  env.port.receive([0x9c]);
  await until(() => env.texts('rx').includes('한'), 'split UTF-8 character completed');
  assert.equal(env.texts('rx'), '한');
  assert.ok(!env.texts('rx').includes('\ufffd'));
  assert.equal(env.texts('tx'), '전송');
  env.value('serial-encoding', 'euc-kr');
  env.click('serial-clear');
  env.port.receive([0xc7]);
  await sleep(25);
  await send(env, '별도 송신');
  env.port.receive([0xd1, 0xb1]);
  await sleep(25);
  env.port.receive([0xdb]);
  await until(() => env.texts('rx').includes('한글'), 'split EUC-KR characters completed');
  assert.equal(env.texts('rx'), '한글');
  assert.ok(!env.texts('rx').includes('\ufffd'));
});

test('clearing the screen does not discard an in-progress Korean receive character', async (t) => {
  const env = await runtime(t, { storage: { [CONFIG_KEY]: savedConfig({ timeOut: 0 }) } });
  await selectAndOpen(env);
  env.port.receive([0xed, 0x95]);
  await until(() => env.rows('rx').length > 0, 'partial receive observed');
  env.click('serial-clear');
  env.port.receive([0x9c]);
  await until(() => env.texts('rx') !== '', 'remaining byte decoded after clear');
  assert.equal(env.texts('rx'), '한');
});

test('TX rendering preserves Korean characters split by the internal 16 KiB log boundary', async (t) => {
  const env = await runtime(t);
  await selectAndOpen(env);
  const content = 'a'.repeat(16383) + '한';
  await send(env, content);
  await until(() => env.rows('tx').length === 2, 'large TX split into bounded log rows');
  assert.deepEqual(env.port.writes[0], encoder.encode(content));
  assert.equal(env.texts('tx'), content);
  assert.ok(!env.texts('tx').includes('\ufffd'));
});

test('Korean IME composition suppresses send shortcuts until composition has finished', async (t) => {
  const env = await runtime(t);
  await selectAndOpen(env);
  env.value('serial-send-content', '한글 조합', 'input');
  const input = env.$('serial-send-content');
  input.focus();
  input.dispatchEvent(new env.window.CompositionEvent('compositionstart', { bubbles: true }));
  input.dispatchEvent(new env.window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
  await sleep(35);
  assert.equal(env.port.calls.write, 0);
  input.dispatchEvent(new env.window.CompositionEvent('compositionend', { bubbles: true }));
  input.dispatchEvent(new env.window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true, bubbles: true }));
  await sleep(20);
  assert.equal(env.port.calls.write, 0);
  input.dispatchEvent(new env.window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
  await until(() => env.port.writes.length === 1, 'shortcut sends after IME completion');
  assert.deepEqual(env.port.writes[0], encoder.encode('한글 조합'));
});

test('repeat transmission requires an explicit send and stops without saving an armed loop', async (t) => {
  const env = await runtime(t);
  await selectAndOpen(env);
  env.value('serial-loop-send-time', 100);
  env.value('serial-send-content', 'AT', 'input');
  env.check('serial-loop-send', true);
  await sleep(130);
  assert.equal(env.port.calls.write, 0, 'checking repeat must not transmit immediately');
  env.click('serial-send');
  await until(() => env.port.writes.length >= 2, 'explicit repeat send active');
  env.click('serial-send');
  await sleep(40);
  const stoppedCount = env.port.writes.length;
  await sleep(150);
  assert.equal(env.port.writes.length, stoppedCount);
  assert.equal(env.$('serial-loop-send').checked, false);
  assert.equal(JSON.parse(env.window.localStorage.getItem(CONFIG_KEY)).toolOptions.loopSend, false);
});

test('a rejected writer.write releases its lock and permits clean disconnect', async (t) => {
  const env = await runtime(t);
  await selectAndOpen(env);
  const writable = env.port.writable;
  env.port.rejectWrite = new env.window.DOMException('simulated writer failure', 'NetworkError');
  await send(env, 'AT');
  await until(() => env.port.calls.writerRelease === 1, 'failed writer released');
  assert.equal(writable.locked, false);
  assert.equal(env.port.writes.length, 0);
  assert.equal(env.port.calls.writerAcquire, 1);
  if (env.$('serial-status').dataset.state === 'connected') env.click('serial-open-or-close');
  await until(() => env.port.calls.close === 1 && !env.port.isOpen, 'failed-write port can close');
  assert.equal(writable.locked, false);
});

test('automatic reconnect only reopens the same previously opened port, never another device', async (t) => {
  const env = await runtime(t);
  env.check('serial-auto-reconnect', true);
  await selectAndOpen(env);
  env.serial.emit('disconnect', env.port);
  await until(() => !env.port.isOpen, 'unplugged port closed');
  await until(() => env.$('serial-status').dataset.state !== 'busy', 'unplug cleanup finished');
  env.serial.emit('connect', env.ports[1]);
  await sleep(100);
  assert.equal(env.port.calls.open, 1);
  assert.equal(env.ports[1].calls.open, 0);
  env.serial.emit('connect', env.port);
  await until(() => env.port.calls.open === 2 && env.$('serial-status').dataset.state === 'connected', 'same device reconnected');
  assert.equal(env.calls.getPorts, 0);
  assert.equal(env.calls.requestPort, 1);
  assert.equal(env.port.calls.write, 0);
  env.click('serial-open-or-close');
  await until(() => env.port.calls.close === 2 && !env.port.isOpen, 'manual close completed');
  env.serial.emit('connect', env.port);
  await sleep(100);
  assert.equal(env.port.calls.open, 2, 'manual disconnect disarms automatic reconnect');
});

test('hardware disconnect during manual cleanup cannot rearm automatic reconnect', async (t) => {
  const env = await runtime(t);
  env.check('serial-auto-reconnect', true);
  await selectAndOpen(env);
  const canceled = deferred();
  env.port.gates.cancel = canceled;
  env.click('serial-open-or-close');
  await until(() => env.port.calls.cancel === 1, 'manual cleanup started');
  env.serial.emit('disconnect', env.port);
  canceled.resolve();
  await until(() => !env.port.isOpen && env.$('serial-status').dataset.state === 'selected', 'manual cleanup completed');
  env.serial.emit('connect', env.port);
  await sleep(120);
  assert.equal(env.port.calls.open, 1);
  assert.equal(env.port.calls.write, 0);
});

test('filters and screen pause preserve reception while bounded logs retain the newest 500 entries', async (t) => {
  const env = await runtime(t, { storage: { [CONFIG_KEY]: savedConfig({ timeOut: 0, logLimit: 500 }) } });
  await selectAndOpen(env);
  env.click('serial-clear');
  env.port.receive(encoder.encode('first HELLO'));
  await until(() => env.texts('rx').includes('first HELLO'), 'first RX shown');
  await send(env, 'TX-only');
  env.value('serial-direction', 'rx');
  await until(() => env.rows().length === 1 && env.rows('rx').length === 1, 'RX-only direction filter');
  env.value('serial-search', 'hello', 'input');
  await until(() => env.rows().length === 1, 'case-insensitive search');
  env.value('serial-search', 'no matching packet', 'input');
  await until(() => env.rows().length === 0, 'nonmatching search hides rows');
  assert.equal(env.$('serial-empty-state').hidden, false);
  assert.equal(env.$('serial-log-count').textContent, '2', 'filtering does not delete stored logs');
  env.value('serial-search', '', 'input');
  env.value('serial-direction', 'all');
  await until(() => env.rows().length === 2, 'all rows restored');
  env.click('serial-pause');
  const frozen = env.$('serial-logs').textContent;
  for (let index = 0; index < 520; index += 1) env.port.receive(encoder.encode(`packet-${String(index).padStart(4, '0')}\n`));
  await until(() => env.$('serial-log-count').textContent === '500', 'log ring buffer bounded while paused');
  await sleep(30);
  assert.equal(env.$('serial-logs').textContent, frozen, 'pause freezes only the displayed snapshot');
  env.click('serial-pause');
  await until(() => env.rows().length === 500 && env.texts('rx').includes('packet-0519'), 'resume shows bounded newest logs');
  assert.ok(!env.texts().includes('first HELLO'));
  assert.ok(!env.texts().includes('packet-0019'));
  assert.ok(env.texts().includes('packet-0020'));
});

test('device markup and saved quick-command markup remain text rather than DOM elements', async (t) => {
  const hostile = '<img src=x onerror="window.serialTestExecuted=true">';
  const env = await runtime(t, { storage: { [CONFIG_KEY]: savedConfig({ timeOut: 0 }, {
    quickSendList: [{ name: hostile, list: [{ name: hostile, content: hostile, hex: false }] }],
    code: 'window.serialTestExecuted = true;',
  }) } });
  assert.equal(env.$('serial-quick-send-content').querySelector('img'), null);
  assert.equal(env.$('serial-quick-send').options[0].textContent, hostile);
  assert.equal(env.calls.worker, 0);
  await selectAndOpen(env);
  env.port.receive(encoder.encode(hostile));
  await until(() => env.texts('rx').includes(hostile), 'literal markup displayed');
  assert.equal(env.$('serial-logs').querySelector('img,script,iframe'), null);
  env.value('serial-log-type', 'ansi');
  env.port.receive(encoder.encode(`\x1b[31m${hostile}\x1b[0m`));
  await until(() => env.rows('rx').length >= 2, 'ANSI packet displayed');
  assert.equal(env.$('serial-logs').querySelector('img,script,iframe'), null);
  assert.equal(env.window.serialTestExecuted, undefined);
});

test('an unrelated import cannot overwrite existing settings or start a script or write', async (t) => {
  const original = savedConfig({ sendContent: '보존할 명령', lineEnding: 'crlf' });
  const env = await runtime(t, { storage: { [CONFIG_KEY]: original } });
  env.file('serial-import-file', '{"unrelated":true}');
  await until(() => env.calls.modals > 0 || env.calls.alerts.length > 0, 'invalid import reported');
  assert.equal(env.window.localStorage.getItem(CONFIG_KEY), original);
  assert.equal(env.$('serial-send-content').value, '보존할 명령');
  assert.equal(env.$('serial-line-ending').value, 'crlf');
  assert.equal(env.calls.worker, 0);
  assert.equal(env.port.calls.write, 0);
});

test('valid imported settings replace the UI atomically without opening, sending or running imported code', async (t) => {
  const env = await runtime(t);
  const imported = savedConfig({ loopSend: true, loopSendTime: 100, sendContent: '새 명령', lineEnding: 'lf', encoding: 'euc-kr', autoReconnect: true }, {
    serialOptions: { ...DEFAULT_SERIAL_OPTIONS, baudRate: 9600 },
    code: 'globalThis.serialTestExecuted = true;',
    history: [{ content: '기록', hex: false, lineEnding: 'none', time: '2026-09-02T00:00:00.000Z' }],
  });
  env.file('serial-import-file', imported);
  await until(() => env.$('serial-send-content').value === '새 명령', 'valid config applied');
  await sleep(150);
  assert.equal(env.$('serial-baud').value, '9600');
  assert.equal(env.$('serial-line-ending').value, 'lf');
  assert.equal(env.$('serial-encoding').value, 'euc-kr');
  assert.equal(env.$('serial-loop-send').checked, false);
  assert.equal(env.$('serial-history').options.length, 2);
  assert.equal(JSON.parse(env.window.localStorage.getItem(CONFIG_KEY)).toolOptions.loopSend, false);
  assert.equal(env.calls.getPorts, 0);
  assert.equal(env.calls.requestPort, 0);
  assert.equal(env.port.calls.open, 0);
  assert.equal(env.port.calls.write, 0);
  assert.equal(env.calls.worker, 0);
  assert.equal(env.window.serialTestExecuted, undefined);
});

test('legacy preferences migrate without deleting original keys or resuming old activity', async (t) => {
  const legacy = {
    serialOptions: JSON.stringify({ ...DEFAULT_SERIAL_OPTIONS, baudRate: 57600 }),
    toolOptions: JSON.stringify({ autoScroll: false, showTime: false, addCRLF: true, loopSend: true, sendContent: '보존한 입력', quickSendIndex: 99 }),
    quickSendList: JSON.stringify([{ name: '보존한 그룹', list: [{ name: '기존 명령', content: 'AT', hex: false }] }]),
    code: '// 보존한 코드',
  };
  const env = await runtime(t, { storage: legacy });
  for (const [key, value] of Object.entries(legacy)) assert.equal(env.window.localStorage.getItem(key), value);
  const migrated = JSON.parse(env.window.localStorage.getItem(CONFIG_KEY));
  assert.equal(migrated.serialOptions.baudRate, 57600);
  assert.equal(migrated.toolOptions.lineEnding, 'crlf');
  assert.equal(migrated.toolOptions.autoScroll, false);
  assert.equal(migrated.toolOptions.showTime, false);
  assert.equal(migrated.toolOptions.loopSend, false);
  assert.equal(migrated.toolOptions.quickSendIndex, 0);
  assert.equal(env.$('serial-send-content').value, '보존한 입력');
  assert.equal(env.$('serial-quick-send').options[0].textContent, '보존한 그룹');
  assert.equal(env.calls.getPorts, 0);
  assert.equal(env.port.calls.open, 0);
  assert.equal(env.port.calls.write, 0);
});

test('corrupt stored settings are preserved while explicit memory-port reception still works', async (t) => {
  const original = '{"broken":"keep this file"}';
  const env = await runtime(t, { storage: { [CONFIG_KEY]: original } });
  await until(() => env.texts('system').includes('기존 데이터'), 'corrupt-setting warning displayed');
  env.value('serial-send-content', '새 임시 입력', 'input');
  assert.equal(env.window.localStorage.getItem(CONFIG_KEY), original);
  await selectAndOpen(env);
  env.port.receive(encoder.encode('한글 수신 확인\r\n'));
  await until(() => env.texts('rx').includes('한글 수신 확인'), 'memory-port RX still works');
  assert.equal(env.window.localStorage.getItem(CONFIG_KEY), original);
  assert.equal(env.port.calls.open, 1);
  assert.equal(env.port.calls.write, 0);
});

test('FUNSR draft slider, numeric field, increments and presets synchronize without saving or transmitting', async (t) => {
  const original = savedConfig();
  const env = await runtime(t, { storage: { [CONFIG_KEY]: original } });
  const assertDraft = (value) => {
    assert.equal(Number(env.$('funsr-speed-value').value), value);
    assert.equal(Number(env.$('funsr-speed-range').value), value);
    assert.equal(env.$('funsr-speed-command').textContent.trim(), `DKP${value.toFixed(1)}`);
  };
  assertDraft(1.2);
  env.value('funsr-speed-range', 4.6, 'input');
  assertDraft(4.6);
  env.value('funsr-speed-value', 2.1, 'input');
  assertDraft(2.1);
  env.click('funsr-speed-increase');
  assertDraft(2.2);
  env.click('funsr-speed-decrease');
  assertDraft(2.1);
  env.click('funsr-speed-minimum');
  assertDraft(0.5);
  env.click('funsr-speed-decrease');
  assertDraft(0.5);
  env.click('funsr-speed-maximum');
  assertDraft(5);
  env.click('funsr-speed-increase');
  assertDraft(5);
  env.click('funsr-speed-default');
  assertDraft(1.2);
  assert.equal(env.window.localStorage.getItem(CONFIG_KEY), original, 'Draft state is not added to the backup schema');
  assert.equal(env.calls.getPorts, 0);
  assert.equal(env.calls.requestPort, 0);
  assert.equal(env.port.calls.write, 0);

  // Synthetic DOM events only: no OS keyboard, browser or real device is used.
  await selectAndOpen(env);
  env.check('funsr-device-confirm', true);
  env.value('serial-send-content', 'old composer command', 'input');
  const numeric = env.$('funsr-speed-value');
  for (const ctrlKey of [false, true]) {
    numeric.dispatchEvent(new env.window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey, bubbles: true }));
  }
  await sleep(35);
  assert.equal(env.port.calls.write, 0, 'Editing FUNSR cannot send the general composer contents');
});

test('FUNSR apply requires an open port, explicit device confirmation and a valid 0.1-step draft', async (t) => {
  const env = await runtime(t);
  assert.equal(env.$('funsr-device-confirm').checked, false);
  assert.equal(env.$('funsr-speed-apply').disabled, true);
  env.check('funsr-device-confirm', true);
  env.click('funsr-speed-apply', true);
  assert.equal(env.port.calls.write, 0);
  env.click('serial-select-port');
  await until(() => env.$('serial-status').dataset.state === 'selected', 'port selected');
  assert.equal(env.$('funsr-device-confirm').checked, false);
  env.check('funsr-device-confirm', true);
  env.click('funsr-speed-apply', true);
  assert.equal(env.port.calls.write, 0, 'Selection is not an open serial connection');
  env.click('serial-open-or-close');
  await until(() => env.$('serial-status').dataset.state === 'connected', 'port opened');
  assert.equal(env.$('funsr-device-confirm').checked, false, 'A new connection requires fresh confirmation');
  env.click('funsr-speed-apply', true);
  await sleep(20);
  assert.equal(env.port.calls.write, 0);
  env.check('funsr-device-confirm', true);
  assert.equal(env.$('funsr-speed-apply').disabled, false);
  for (const invalid of ['', '0.4', '5.1', '1.25']) {
    env.value('funsr-speed-value', invalid, 'input');
    assert.equal(env.$('funsr-speed-apply').disabled, true);
    env.click('funsr-speed-apply', true);
  }
  await sleep(20);
  assert.equal(env.port.calls.write, 0);
  env.value('funsr-speed-value', '1.2', 'input');
  assert.equal(env.$('funsr-speed-apply').disabled, false);
  assert.match(env.$('funsr-speed-reported').textContent, /아직 확인하지 않음/);
});

test('FUNSR apply sends one exact DKP+CRLF independently of generic HEX, newline and merely armed repeat settings', async (t) => {
  const env = await runtime(t);
  await selectAndOpen(env);
  env.check('serial-hex-send', true);
  env.value('serial-line-ending', 'none');
  env.value('serial-loop-send-time', 100);
  env.check('serial-loop-send', true); // Armed is distinct from an active repeat loop.
  env.value('serial-send-content', 'not valid HEX', 'input');
  await requestFunsr(env, 4.6);
  assert.deepEqual(env.port.writes, [Uint8Array.of(68, 75, 80, 52, 46, 54, 13, 10)]);
  assert.equal(funsrState(env), 'waiting', 'Writer completion is not device save confirmation');
  assert.match(env.$('funsr-speed-reported').textContent, /아직 확인하지 않음/);
  assert.equal(env.$('serial-hex-send').checked, true);
  assert.equal(env.$('serial-line-ending').value, 'none');
  assert.equal(env.$('serial-send-content').value, 'not valid HEX');
  await sleep(230);
  assert.equal(env.port.calls.write, 1, 'Dedicated apply must never join the generic repeat sender');
});

test('FUNSR rejects duplicate clicks while the first write is still pending', async (t) => {
  const env = await runtime(t);
  await selectAndOpen(env);
  env.value('funsr-speed-value', 4.6, 'input');
  env.check('funsr-device-confirm', true);
  const gate = deferred();
  env.port.gates.write = gate;
  env.click('funsr-speed-apply');
  await until(() => env.port.calls.write === 1, 'DKP write pending');
  env.click('funsr-speed-apply', true);
  env.click('funsr-speed-apply', true);
  assert.equal(env.$('funsr-speed-apply').disabled, true);
  assert.equal(env.port.calls.write, 1);
  gate.resolve();
  await until(() => funsrState(env) === 'waiting', 'original write completed exactly once');
  assert.equal(env.port.writes.length, 1);
  assert.equal(env.port.calls.writerAcquire, 1);
  assert.equal(env.port.calls.writerRelease, 1);
});

test('FUNSR apply is blocked during active repeating or a running user script, then reenabled after explicit stop', async (t) => {
  const env = await runtime(t);
  await selectAndOpen(env);
  env.check('funsr-device-confirm', true);
  env.value('serial-loop-send-time', 100);
  env.value('serial-send-content', 'AT', 'input');
  env.check('serial-loop-send', true);
  env.click('serial-send');
  await until(() => env.port.writes.length >= 1, 'generic loop started');
  assert.equal(env.$('funsr-speed-apply').disabled, true);
  env.click('funsr-speed-apply', true);
  assert.equal(dkpWrites(env).length, 0);
  env.click('serial-send');
  await until(() => !env.$('funsr-speed-apply').disabled, 'DKP reenabled after stopping repeat');

  env.click('serial-code-run');
  await until(() => env.calls.worker === 1, 'stubbed user worker started');
  assert.equal(env.$('funsr-speed-apply').disabled, true);
  env.click('funsr-speed-apply', true);
  assert.equal(dkpWrites(env).length, 0);
  env.click('serial-code-run');
  await until(() => env.calls.workerTerminated === 1 && !env.$('funsr-speed-apply').disabled, 'DKP reenabled after stopping worker');
  await requestFunsr(env, 1.2);
  assert.deepEqual(dkpWrites(env), [encoder.encode('DKP1.2\r\n')]);
});

test('FUNSR split RX ACK confirms the sent value, while boot reports remain separate from the edited draft', async (t) => {
  const env = await runtime(t, { storage: { [CONFIG_KEY]: savedConfig({ timeOut: 0 }) } });
  await selectAndOpen(env);
  await requestFunsr(env, 4.6);
  env.value('funsr-speed-value', 3.0, 'input');
  for (const part of ['new k', 'p is 4.', '60!\r', '\n']) env.port.receive(encoder.encode(part));
  await sleep(35);
  assert.notEqual(funsrState(env), 'saved', 'A reported new value alone is not a save ACK');
  // The save ACK and a partial boot line share one RX chunk. Finishing the ACK
  // must not discard the parser's prefix for the subsequent boot report.
  for (const part of ['kp sav', 'ed, please ', 'reboot!\r\nMotor global kp is 4.']) env.port.receive(encoder.encode(part));
  await until(() => funsrState(env) === 'saved', 'matching value plus saved reply acknowledged');
  assert.match(env.$('funsr-speed-status').textContent, /4\.60?/);
  assert.match(env.$('funsr-speed-status').textContent, /재시작|재부팅/);
  assert.match(env.$('funsr-speed-reported').textContent, /아직 확인하지 않음/);
  assert.equal(Number(env.$('funsr-speed-value').value), 3.0);
  for (const part of ['60\r', '\n']) env.port.receive(encoder.encode(part));
  await until(() => /4\.60?/.test(env.$('funsr-speed-reported').textContent), 'boot output separately reported');
  assert.equal(Number(env.$('funsr-speed-value').value), 3.0, 'Device report never rewrites the input draft');
  assert.equal(env.port.calls.write, 1, 'No reboot, query or motion command is invented');
});

test('FUNSR wrong-value, reordered and stale pre-request replies cannot confirm a current request', async (t) => {
  const env = await runtime(t, { storage: { [CONFIG_KEY]: savedConfig({ timeOut: 0 }) } });
  await selectAndOpen(env);
  env.port.receive(encoder.encode('new kp is 4.60!\r\nkp saved, please reboot!\r\n'));
  await sleep(25);
  await requestFunsr(env, 4.6);
  env.port.receive(encoder.encode('kp saved, please reboot!\r\n'));
  await sleep(25);
  assert.notEqual(funsrState(env), 'saved');
  // Cross the parser's per-push event cap: the final mismatching value must
  // still invalidate all preceding matches before the saved line is handled.
  env.port.receive(encoder.encode('new kp is 4.60!\r\n'.repeat(200) + 'new kp is 4.50!\r\nkp saved, please reboot!\r\n'));
  await sleep(25);
  assert.notEqual(funsrState(env), 'saved');
  env.port.receive(encoder.encode('new kp is 4.60!\r\n'));
  await sleep(25);
  assert.notEqual(funsrState(env), 'saved', 'Earlier saved text cannot be reused for a later matching value');
  env.port.receive(encoder.encode('kp saved, please reboot!\r\n'));
  await until(() => funsrState(env) === 'saved', 'fresh correctly ordered matching ACK accepted');
});

test('FUNSR partial responses received before the request cannot be completed into a fresh ACK', async (t) => {
  const env = await runtime(t, { storage: { [CONFIG_KEY]: savedConfig({ timeOut: 0 }) } });
  await selectAndOpen(env);
  env.port.receive(encoder.encode('new kp is 4.'));
  await sleep(25);
  await requestFunsr(env, 4.6);
  env.port.receive(encoder.encode('60!\r\nkp saved, please reboot!\r\n'));
  await sleep(35);
  assert.notEqual(funsrState(env), 'saved');
});

test('FUNSR TX and script/system log text cannot impersonate RX ACKs or boot reports', async (t) => {
  const env = await runtime(t);
  await selectAndOpen(env);
  const spoof = 'new kp is 4.60!\r\nkp saved, please reboot!\r\nMotor global kp is 4.60\r\n';
  await send(env, spoof);
  env.click('serial-code-run');
  await until(() => env.workers.length === 1, 'stub worker available');
  env.workers[0].onmessage({ data: { type: 'log', data: spoof } });
  env.click('serial-code-run');
  assert.match(env.$('funsr-speed-reported').textContent, /아직 확인하지 않음/);
  await requestFunsr(env, 4.6);
  env.port.receive(encoder.encode('kp saved, please reboot!\r\n'));
  await sleep(35);
  assert.notEqual(funsrState(env), 'saved');
  assert.match(env.$('funsr-speed-reported').textContent, /아직 확인하지 않음/);
});

test('FUNSR disconnect before the queued write begins cancels it without a replay', async (t) => {
  const env = await runtime(t);
  await selectAndOpen(env);
  env.value('funsr-speed-value', 4.6, 'input');
  env.check('funsr-device-confirm', true);
  env.click('funsr-speed-apply');
  env.click('serial-open-or-close');
  await until(() => !env.port.isOpen && env.port.calls.close === 1, 'close canceled queued DKP');
  assert.equal(env.port.calls.write, 0);
  assert.equal(env.$('funsr-device-confirm').checked, false);
  assert.equal(funsrState(env), 'disconnected');
  env.click('serial-open-or-close');
  await until(() => env.port.isOpen && env.port.calls.open === 2, 'port reopened explicitly');
  await sleep(35);
  assert.equal(env.port.calls.write, 0);
  assert.equal(env.$('funsr-device-confirm').checked, false);
});

test('FUNSR in-flight disconnect and same-port reconnect clear confirmation and stale request state without replay', async (t) => {
  const env = await runtime(t);
  env.check('serial-auto-reconnect', true);
  await selectAndOpen(env);
  env.value('funsr-speed-value', 4.6, 'input');
  env.check('funsr-device-confirm', true);
  const gate = deferred();
  env.port.gates.write = gate;
  env.click('funsr-speed-apply');
  await until(() => env.port.calls.write === 1, 'DKP write in flight');
  env.serial.emit('disconnect', env.port);
  gate.resolve();
  await until(() => !env.port.isOpen, 'in-flight disconnect completed');
  assert.equal(env.$('funsr-device-confirm').checked, false);
  env.serial.emit('connect', env.port);
  await until(() => env.port.calls.open === 2 && env.$('serial-status').dataset.state === 'connected', 'same device reconnected');
  assert.equal(env.$('funsr-device-confirm').checked, false);
  env.port.receive(encoder.encode('new kp is 4.60!\r\nkp saved, please reboot!\r\n'));
  await sleep(40);
  assert.notEqual(funsrState(env), 'saved');
  assert.equal(env.port.calls.write, 1, 'A new session never repeats a previous DKP request');
  assert.equal(env.$('funsr-speed-apply').disabled, true);
});

test('FUNSR a rejected write releases its lock and cannot be changed into success by later ACK text', async (t) => {
  const env = await runtime(t);
  await selectAndOpen(env);
  env.value('funsr-speed-value', 4.6, 'input');
  env.check('funsr-device-confirm', true);
  env.port.rejectWrite = new env.window.DOMException('simulated DKP write failure', 'NetworkError');
  env.click('funsr-speed-apply');
  await until(() => funsrState(env) === 'error', 'DKP write error surfaced');
  assert.equal(env.port.writes.length, 0);
  assert.equal(env.port.writable.locked, false);
  assert.equal(env.port.calls.writerAcquire, env.port.calls.writerRelease);
  env.port.receive(encoder.encode('new kp is 4.60!\r\nkp saved, please reboot!\r\n'));
  await sleep(35);
  assert.notEqual(funsrState(env), 'saved');
});

test('FUNSR drafts and confirmation are not restored or transmitted from imported configuration', async (t) => {
  const env = await runtime(t);
  const imported = savedConfig({ loopSend: true, autoReconnect: true, funsrKp: 4.6, funsrConfirmed: true }, { code: 'postMessage({ type: "uart_send_txt", data: "DKP4.6" });' });
  env.file('serial-import-file', imported);
  await until(() => env.calls.modals > 0, 'configuration import acknowledged');
  assert.equal(Number(env.$('funsr-speed-value').value), 1.2);
  assert.equal(env.$('funsr-device-confirm').checked, false);
  assert.equal(env.calls.worker, 0);
  assert.equal(env.calls.getPorts, 0);
  assert.equal(env.port.calls.open, 0);
  assert.equal(env.port.calls.write, 0);
  const stored = JSON.parse(env.window.localStorage.getItem(CONFIG_KEY));
  assert.equal(Object.hasOwn(stored.toolOptions, 'funsrKp'), false);
  assert.equal(Object.hasOwn(stored.toolOptions, 'funsrConfirmed'), false);
});

test('FUNSR missing ACK reaches a finite unconfirmed-save state without retries or invented success', async (t) => {
  const env = await runtime(t);
  await selectAndOpen(env);
  await requestFunsr(env, 4.6);
  await until(() => funsrState(env) === 'unconfirmed-save', 'finite device ACK timeout', 12000);
  assert.match(env.$('funsr-speed-status').textContent, /미확인|확인하지|확인되지/);
  assert.equal(env.port.calls.write, 1);
  assert.match(env.$('funsr-speed-reported').textContent, /아직 확인하지 않음/);
  env.port.receive(encoder.encode('new kp is 4.60!\r\nkp saved, please reboot!\r\n'));
  await sleep(35);
  assert.notEqual(funsrState(env), 'saved', 'Expired requests cannot consume later stale ACK text');
  assert.equal(env.port.calls.write, 1);
});

test('FUNSR ACK received before writer resolution cannot claim saved until that write completes', async (t) => {
  const env = await runtime(t);
  await selectAndOpen(env);
  env.value('funsr-speed-value', 4.6, 'input');
  env.check('funsr-device-confirm', true);
  const gate = deferred();
  env.port.gates.write = gate;
  env.click('funsr-speed-apply');
  await until(() => env.port.calls.write === 1, 'write has started but not resolved');
  env.port.receive(encoder.encode('new kp is 4.60!\r\nkp saved, please reboot!\r\n'));
  await sleep(40);
  assert.equal(funsrState(env), 'sending');
  assert.equal(env.port.writes.length, 0);
  gate.resolve();
  await until(() => funsrState(env) === 'saved', 'successful write now permits the already received matching ACK');
  assert.deepEqual(env.port.writes, [encoder.encode('DKP4.6\r\n')]);
});

test('FUNSR an ACK followed by writer rejection remains an error, never a successful save', async (t) => {
  const env = await runtime(t);
  await selectAndOpen(env);
  env.value('funsr-speed-value', 4.6, 'input');
  env.check('funsr-device-confirm', true);
  const gate = deferred();
  env.port.gates.write = gate;
  env.port.rejectWrite = new env.window.DOMException('failure after early response', 'NetworkError');
  env.click('funsr-speed-apply');
  await until(() => env.port.calls.write === 1, 'write awaiting resolution');
  env.port.receive(encoder.encode('new kp is 4.60!\r\nkp saved, please reboot!\r\n'));
  await sleep(35);
  assert.equal(funsrState(env), 'sending');
  gate.resolve();
  await until(() => funsrState(env) === 'error', 'write failure takes precedence over early ACK flags');
  assert.equal(env.port.writes.length, 0);
  assert.equal(env.port.writable.locked, false);
  assert.equal(env.port.calls.writerAcquire, env.port.calls.writerRelease);
  assert.ok(!env.texts('system').includes('저장 응답을 확인했습니다.'));
});

test('FUNSR is blocked while another composer, repeat or worker write owns the writer', async (t) => {
  for (const source of ['composer', 'repeat', 'worker']) {
    await t.test(source, async (t) => {
      const env = await runtime(t);
      await selectAndOpen(env);
      env.check('funsr-device-confirm', true);
      const gate = deferred();
      env.port.gates.write = gate;
      if (source === 'worker') {
        env.click('serial-code-run');
        await until(() => env.workers.length === 1, 'stubbed worker started');
        env.workers[0].onmessage({ data: { type: 'uart_send_txt', data: 'AT' } });
      } else {
        env.value('serial-send-content', 'AT', 'input');
        if (source === 'repeat') env.check('serial-loop-send', true);
        env.click('serial-send');
      }
      await until(() => env.port.calls.write === 1, `${source} write pending`);
      if (source === 'worker') env.click('serial-code-run'); // Writer can outlive the stopped worker.
      assert.equal(env.$('funsr-speed-apply').disabled, true);
      env.click('funsr-speed-apply', true);
      await sleep(20);
      assert.equal(env.port.calls.write, 1);
      assert.equal(dkpWrites(env).length, 0);
      gate.resolve();
      await until(() => env.port.writes.length === 1 && !env.port.writable.locked, `${source} write completed`);
      if (source === 'repeat') {
        await until(() => env.$('serial-send').textContent.includes('반복'), 'repeat activated only after its first write');
        env.click('serial-send');
      }
      await until(() => !env.$('funsr-speed-apply').disabled, 'dedicated apply reenabled after other sender is stopped');
      assert.equal(dkpWrites(env).length, 0, 'Reenabling never replays the rejected apply click');
    });
  }
});

test('FUNSR pending ACK blocks ordinary, quick, repeated and script senders until the request finishes', async (t) => {
  const env = await runtime(t);
  await selectAndOpen(env);
  await requestFunsr(env, 4.6);
  env.value('serial-send-content', 'AT', 'input');
  env.click('serial-send', true);
  const quick = env.$('serial-quick-send-content').querySelector('.quick-send');
  quick.dispatchEvent(new env.window.MouseEvent('click', { bubbles: true }));
  env.check('serial-loop-send', true);
  env.click('serial-send', true);
  env.click('serial-code-run', true);
  await sleep(40);
  assert.equal(env.port.calls.write, 1);
  assert.equal(env.calls.worker, 0);
  assert.equal(funsrState(env), 'waiting', 'Blocked senders cannot replace the current DKP request');
  env.port.receive(encoder.encode('new kp is 4.60!\r\nkp saved, please reboot!\r\n'));
  await until(() => funsrState(env) === 'saved', 'original DKP request confirmed');
  await send(env, 'AT');
  assert.equal(env.port.calls.write, 2);
  assert.deepEqual(env.port.writes[1], encoder.encode('AT'));
});
