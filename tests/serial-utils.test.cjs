const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const utils = require('../js/serial-utils.js');
const {
  DEFAULT_SERIAL_OPTIONS,
  DEFAULT_TOOL_OPTIONS,
  parseHex,
  bytesToHex,
  appendLineEnding,
  validateSerialOptions,
  normalizeToolOptions,
  validateQuickSendList,
  parseImportedConfig,
  createTextStreamDecoder,
  formatBytes,
  formatTimestamp,
  addHistory,
} = utils;

function validConfig(overrides = {}) {
  return {
    schemaVersion: 1,
    serialOptions: { ...DEFAULT_SERIAL_OPTIONS },
    toolOptions: { ...DEFAULT_TOOL_OPTIONS },
    quickSendList: [{ name: '기본 명령', list: [{ name: '상태', content: 'AT', hex: false }] }],
    code: '// 명시적으로 실행하기 전까지는 코드가 실행되지 않습니다.',
    ...overrides,
  };
}

function historyEntry(content, overrides = {}) {
  return { content, hex: false, lineEnding: 'none', time: '2026-09-02T01:02:03.000Z', ...overrides };
}

test('the dependency-free bundle exposes the same browser and CommonJS API', () => {
  const source = fs.readFileSync(path.join(__dirname, '../js/serial-utils.js'), 'utf8');
  const context = vm.createContext({ TextDecoder });
  vm.runInContext(source, context);
  assert.equal(typeof context.SerialUtils.parseHex, 'function');
  assert.equal(context.SerialUtils.bytesToHex(context.SerialUtils.parseHex('4869')), '48 69');
  assert.ok(Object.isFrozen(DEFAULT_SERIAL_OPTIONS));
  assert.ok(Object.isFrozen(DEFAULT_TOOL_OPTIONS));
});

test('HEX accepts byte pairs, continuous bytes, commas, whitespace and per-byte prefixes', () => {
  for (const source of ['48 65 6c 6C 6f', '48656c6c6f', '0x48 0X65 6c6c 0x6f', '48,65,6C,6c,6F', '\n48\t65 , 6c\r\n6c, 6f\n']) {
    assert.deepEqual(parseHex(source), Uint8Array.of(72, 101, 108, 108, 111), source);
  }
  assert.deepEqual(parseHex(''), new Uint8Array());
  assert.deepEqual(parseHex(' \n\t'), new Uint8Array());
  assert.deepEqual(parseHex('00ff'), Uint8Array.of(0, 255));
});

test('HEX rejects partial bytes and malformed separators instead of sending partial data', () => {
  for (const source of ['F', '123', '1 23', '0x1', '0x0011', '0x', '0x48x', '0x480x65', '480x65', 'GG', '4G', '48;65', '48:65', '48,,65', ',48', '48,', '48, ,65', '-1', '한글']) {
    assert.throws(() => parseHex(source), /HEX/, source);
  }
  for (const source of [null, undefined, 48, ['48'], { toString: () => '48' }]) {
    assert.throws(() => parseHex(source), /문자열/);
  }
});

test('HEX formatting is uppercase and honors buffer view boundaries', () => {
  assert.equal(bytesToHex([0, 1, 15, 16, 255]), '00 01 0F 10 FF');
  const bytes = Uint8Array.of(255, 72, 105, 254);
  assert.equal(bytesToHex(bytes.subarray(1, 3)), '48 69');
  assert.equal(bytesToHex(new DataView(bytes.buffer, 1, 2)), '48 69');
  assert.equal(bytesToHex(Uint8Array.of(0, 255).buffer), '00 FF');
  assert.equal(bytesToHex([]), '');
  for (const bytes of [[-1], [256], [1.5], ['10'], [NaN], '48']) {
    assert.throws(() => bytesToHex(bytes), /바이트/);
  }
});

test('line endings are exact bytes and never mutate or alias the original input', () => {
  const original = Uint8Array.of(0, 65, 255);
  const suffixes = { none: [], lf: [10], cr: [13], crlf: [13, 10] };
  for (const [ending, suffix] of Object.entries(suffixes)) {
    const actual = appendLineEnding(original, ending);
    assert.deepEqual(actual, Uint8Array.from([0, 65, 255, ...suffix]));
    actual[0] = 99;
    assert.deepEqual(original, Uint8Array.of(0, 65, 255));
  }
  assert.deepEqual(appendLineEnding(new Uint8Array(), 'crlf'), Uint8Array.of(13, 10));
  assert.throws(() => appendLineEnding(original, 'LF'), /줄바꿈/);
});

test('serial options normalize decimal form values and fill omitted defaults', () => {
  assert.deepEqual(validateSerialOptions(), DEFAULT_SERIAL_OPTIONS);
  assert.deepEqual(validateSerialOptions({ baudRate: '9600', dataBits: '7', stopBits: '2', parity: 'even', bufferSize: '2048', flowControl: 'hardware' }), {
    baudRate: 9600, dataBits: 7, stopBits: 2, parity: 'even', bufferSize: 2048, flowControl: 'hardware',
  });
  assert.deepEqual(validateSerialOptions({ baudRate: 1, bufferSize: 16777216 }), { ...DEFAULT_SERIAL_OPTIONS, baudRate: 1, bufferSize: 16777216 });
  assert.equal(validateSerialOptions({ baudRate: 4000000 }).baudRate, 4000000);
});

test('serial options reject invalid numbers, enums and types instead of coercing them', () => {
  for (const baudRate of [NaN, Infinity, -Infinity, 0, -1, 4000001, 9600.5, '', ' ', '9600junk', '0x2580', null, true, {}, []]) {
    assert.throws(() => validateSerialOptions({ baudRate }), /전송 속도/);
  }
  for (const bufferSize of [0, -1, 16777217, 0.5, NaN]) {
    assert.throws(() => validateSerialOptions({ bufferSize }), /버퍼/);
  }
  for (const dataBits of [6, 9, 7.5, '']) assert.throws(() => validateSerialOptions({ dataBits }), /데이터 비트/);
  for (const stopBits of [0, 1.5, 3]) assert.throws(() => validateSerialOptions({ stopBits }), /정지 비트/);
  for (const parity of ['mark', 'NONE', '', true]) assert.throws(() => validateSerialOptions({ parity }), /패리티/);
  for (const flowControl of ['software', 'Hardware', 1]) assert.throws(() => validateSerialOptions({ flowControl }), /흐름 제어/);
  for (const source of [null, [], 1, '9600']) assert.throws(() => validateSerialOptions(source), /객체/);
});

test('tool option normalization preserves false flags and migrates legacy CRLF', () => {
  assert.deepEqual(normalizeToolOptions(), DEFAULT_TOOL_OPTIONS);
  const source = { autoScroll: false, showTime: false, wrap: false, hexSend: false, addCRLF: true, loopSend: true, quickSendIndex: '2', logType: 'hex&text' };
  const copy = JSON.stringify(source);
  const actual = normalizeToolOptions(source);
  assert.equal(actual.autoScroll, false);
  assert.equal(actual.showTime, false);
  assert.equal(actual.wrap, false);
  assert.equal(actual.hexSend, false);
  assert.equal(actual.lineEnding, 'crlf');
  assert.equal(actual.loopSend, false);
  assert.equal(actual.quickSendIndex, 2);
  assert.equal(actual.logType, 'hex&text');
  assert.equal(Object.hasOwn(actual, 'addCRLF'), false);
  assert.equal(JSON.stringify(source), copy);
  assert.equal(normalizeToolOptions({ addCRLF: false }).lineEnding, 'none');
  assert.equal(normalizeToolOptions({ addCRLF: true, lineEnding: 'lf' }).lineEnding, 'lf');
});

test('tool option normalization clamps numeric values and excludes unexpected enums and keys', () => {
  const actual = normalizeToolOptions({
    timeOut: -1, loopSendTime: 0, quickSendIndex: 900, logLimit: 1000000,
    encoding: 'javascript:', lineEnding: '<script>', logType: 'bogus',
    autoReconnect: 'false', hexSend: 'true', sendContent: { html: 'x' }, extra: 'ignored',
  });
  assert.equal(actual.timeOut, 0);
  assert.equal(actual.loopSendTime, 100);
  assert.equal(actual.quickSendIndex, 49);
  assert.equal(actual.logLimit, 10000);
  assert.equal(actual.encoding, 'utf-8');
  assert.equal(actual.lineEnding, 'none');
  assert.equal(actual.logType, 'text');
  assert.equal(actual.autoReconnect, false);
  assert.equal(actual.hexSend, false);
  assert.equal(actual.sendContent, '');
  assert.equal(Object.hasOwn(actual, 'extra'), false);
  assert.equal(normalizeToolOptions({ timeOut: 90000 }).timeOut, 5000);
  assert.equal(normalizeToolOptions({ loopSendTime: 9000000 }).loopSendTime, 3600000);
  assert.equal(normalizeToolOptions({ timeOut: NaN, loopSendTime: Infinity }).timeOut, 50);
  assert.equal(normalizeToolOptions({ timeOut: NaN, loopSendTime: Infinity }).loopSendTime, 1000);
  assert.equal(normalizeToolOptions({ timeOut: '250', loopSendTime: 501.9 }).loopSendTime, 501);
  assert.equal(normalizeToolOptions({ sendContent: 'x'.repeat(65537) }).sendContent.length, 65536);
  assert.deepEqual(normalizeToolOptions(null), DEFAULT_TOOL_OPTIONS);
  assert.deepEqual(normalizeToolOptions([]), DEFAULT_TOOL_OPTIONS);
});

test('quick-send groups become independent plain data and preserve hostile HTML literally', () => {
  const hostile = '<img src=x onerror="globalThis.pwned=true">';
  const source = [{ name: hostile, list: [{ name: hostile, content: hostile, hex: false, ignored: 1 }] }];
  const actual = validateQuickSendList(source);
  assert.deepEqual(actual, [{ name: hostile, list: [{ name: hostile, content: hostile, hex: false }] }]);
  assert.notEqual(actual, source);
  assert.notEqual(actual[0].list, source[0].list);
  assert.notEqual(actual[0].list[0], source[0].list[0]);
  actual[0].list[0].content = '바뀐 복사본';
  assert.equal(source[0].list[0].content, hostile);
  assert.deepEqual(validateQuickSendList([{ name: ' 새 그룹 ', list: [] }]), [{ name: '새 그룹', list: [] }]);
  assert.equal(validateQuickSendList([{ name: '기본', list: [{ name: '명령', content: '' }] }])[0].list[0].hex, false);
});

test('quick-send rejects malformed structures and oversized lists or text', () => {
  for (const source of [null, {}, [], Array(1), ['name'], [{ name: '빈 그룹' }], [{ name: '', list: [] }], [{ name: 1, list: [] }], [{ name: '그룹', list: 'AT' }], [{ name: '그룹', list: Array(1) }]]) {
    assert.throws(() => validateQuickSendList(source), /빠른 전송/);
  }
  for (const item of [null, {}, { name: '', content: '' }, { name: '명령', content: 1 }, { name: '명령', content: '', hex: 'false' }, { name: 'x'.repeat(121), content: '' }, { name: '명령', content: 'x'.repeat(65537) }]) {
    assert.throws(() => validateQuickSendList([{ name: '그룹', list: [item] }]), /빠른 전송/);
  }
  const item = { name: '명령', content: '', hex: false };
  assert.throws(() => validateQuickSendList(Array.from({ length: 51 }, () => ({ name: '그룹', list: [] }))), /빠른 전송/);
  assert.throws(() => validateQuickSendList([{ name: '그룹', list: Array.from({ length: 201 }, () => item) }]), /빠른 전송/);
  assert.throws(() => validateQuickSendList(Array.from({ length: 6 }, () => ({ name: '그룹', list: Array.from({ length: 200 }, () => item) }))), /빠른 전송/);
  assert.throws(() => validateQuickSendList([{ name: '그룹', list: Array.from({ length: 17 }, () => ({ name: '명령', content: 'x'.repeat(65536), hex: false })) }]), /빠른 전송/);
});

test('quick-send rejects array getters and overwritten methods without executing them', () => {
  let executed = false;
  const getterList = [];
  Object.defineProperty(getterList, '0', { get() { executed = true; return { name: '명령', content: 'AT' }; } });
  assert.throws(() => validateQuickSendList([{ name: '그룹', list: getterList }]), /허용되지/);
  const overridden = [{ name: '그룹', list: [] }];
  overridden.map = () => { executed = true; return []; };
  assert.throws(() => validateQuickSendList(overridden), /허용되지/);
  assert.equal(executed, false);
});

test('typed config imports atomically, clamps group selection, and never starts a send loop', () => {
  const source = validConfig({ toolOptions: { autoScroll: false, showTime: false, wrap: false, loopSend: true, autoReconnect: true, quickSendIndex: 999, encoding: 'euc-kr' } });
  const before = JSON.stringify(source);
  const actual = parseImportedConfig(source);
  assert.equal(actual.toolOptions.loopSend, false);
  assert.equal(actual.toolOptions.autoScroll, false);
  assert.equal(actual.toolOptions.showTime, false);
  assert.equal(actual.toolOptions.wrap, false);
  assert.equal(actual.toolOptions.quickSendIndex, 0);
  assert.equal(actual.toolOptions.encoding, 'euc-kr');
  assert.equal(actual.toolOptions.autoReconnect, true);
  assert.equal(Object.hasOwn(actual, 'history'), false);
  assert.equal(JSON.stringify(source), before);
  assert.notEqual(actual.quickSendList[0], source.quickSendList[0]);
  assert.deepEqual(parseImportedConfig(JSON.stringify(source)), actual);
});

test('legacy double-encoded exports migrate CRLF, numeric inputs, false flags and null defaults', () => {
  const actual = parseImportedConfig(JSON.stringify({
    serialOptions: JSON.stringify({ baudRate: '9600', dataBits: 8 }),
    toolOptions: JSON.stringify({ autoScroll: false, showTime: false, addCRLF: true, loopSend: true, quickSendIndex: 42 }),
    quickSendList: JSON.stringify([{ name: '기존 명령', list: [{ name: '테스트', content: 'AT', hex: false }] }]),
    code: 'postMessage({type: "uart_send_txt", data: "한글"});',
  }));
  assert.equal(actual.serialOptions.baudRate, 9600);
  assert.equal(actual.toolOptions.lineEnding, 'crlf');
  assert.equal(actual.toolOptions.autoScroll, false);
  assert.equal(actual.toolOptions.showTime, false);
  assert.equal(actual.toolOptions.loopSend, false);
  assert.equal(actual.toolOptions.quickSendIndex, 0);
  assert.equal(actual.quickSendList[0].name, '기존 명령');
  assert.match(actual.code, /한글/);
  const empty = parseImportedConfig({ serialOptions: null, toolOptions: null, quickSendList: null, code: null });
  assert.deepEqual(empty.serialOptions, DEFAULT_SERIAL_OPTIONS);
  assert.deepEqual(empty.toolOptions, DEFAULT_TOOL_OPTIONS);
  assert.deepEqual(empty.quickSendList, [{ name: '기본 명령', list: [] }]);
  assert.equal(empty.code, '');
});

test('unrelated, incomplete or unsupported config files cannot reset stored settings', () => {
  for (const source of ['{', 'null', '[]', '{}', '{"hello":"world"}', null, [], {}, { serialOptions: {} }, validConfig({ schemaVersion: 2 }), validConfig({ schemaVersion: '1' }), validConfig({ code: null }), validConfig({ serialOptions: null }), validConfig({ toolOptions: [] }), validConfig({ quickSendList: [] }), validConfig({ serialOptions: { baudRate: -1 } }), validConfig({ toolOptions: { encoding: 'unknown' } }), validConfig({ toolOptions: { autoScroll: 'false' } }), validConfig({ toolOptions: { sendContent: 42 } })]) {
    assert.throws(() => parseImportedConfig(source));
  }
  for (const key of ['serialOptions', 'toolOptions', 'quickSendList', 'code']) {
    const source = validConfig();
    delete source[key];
    assert.throws(() => parseImportedConfig(source), /설정 파일/);
  }
  assert.throws(() => parseImportedConfig({ serialOptions: '{bad', toolOptions: '{}', quickSendList: '[]', code: '' }), /JSON/);
  assert.throws(() => parseImportedConfig(validConfig({ code: 'x'.repeat(262145) })), /스크립트/);
  assert.throws(() => parseImportedConfig(validConfig({ toolOptions: { sendContent: 'x'.repeat(65537) } })), /전송 내용/);
  assert.throws(() => parseImportedConfig(' '.repeat(2097153)), /크기/);
});

test('config import rejects prototype pollution keys, accessors and cycles without side effects', () => {
  for (const malicious of ['"__proto__":{"polluted":true}', '"constructor":{"prototype":{"polluted":true}}', '"prototype":{"polluted":true}']) {
    const source = JSON.stringify(validConfig()).replace('{', `{${malicious},`);
    assert.throws(() => parseImportedConfig(source), /허용되지/);
  }
  const nested = validConfig();
  nested.quickSendList[0] = JSON.parse('{"name":"그룹","list":[],"__proto__":{"polluted":true}}');
  assert.throws(() => parseImportedConfig(nested), /허용되지/);
  const legacy = { serialOptions: '{"__proto__":{"polluted":true}}', toolOptions: '{}', quickSendList: '[{"name":"그룹","list":[]}]', code: '' };
  assert.throws(() => parseImportedConfig(legacy), /허용되지/);
  let getterCalled = false;
  const accessor = validConfig();
  Object.defineProperty(accessor, 'code', { enumerable: true, get() { getterCalled = true; return ''; } });
  assert.throws(() => parseImportedConfig(accessor), /허용되지/);
  assert.equal(getterCalled, false);
  const cyclic = validConfig();
  cyclic.extra = cyclic;
  assert.throws(() => parseImportedConfig(cyclic), /순환/);
  const inherited = Object.create({ baudRate: 9600 });
  assert.throws(() => validateSerialOptions(inherited), /객체/);
  assert.equal({}.polluted, undefined);
});

test('config validation fails before mutating any previously validated field', () => {
  const source = validConfig({ toolOptions: { addCRLF: true, loopSend: true }, code: 42 });
  const before = JSON.stringify(source);
  assert.throws(() => parseImportedConfig(source), /스크립트/);
  assert.equal(JSON.stringify(source), before);
  const tooDeep = validConfig();
  let cursor = tooDeep;
  for (let index = 0; index < 30; index += 1) { cursor.extra = {}; cursor = cursor.extra; }
  assert.throws(() => parseImportedConfig(tooDeep), /복잡/);
});

test('import leaves hostile markup and script source as inert data', () => {
  const hostile = '<script>globalThis.__serialUtilityExecuted = true</script>';
  const source = validConfig({
    quickSendList: [{ name: hostile, list: [{ name: hostile, content: hostile, hex: false }] }],
    code: 'globalThis.__serialUtilityExecuted = true;',
  });
  const actual = parseImportedConfig(source);
  assert.equal(actual.quickSendList[0].list[0].content, hostile);
  assert.equal(actual.code, source.code);
  assert.equal(globalThis.__serialUtilityExecuted, undefined);
});

test('UTF-8 streaming preserves Korean characters across arbitrary packet boundaries', () => {
  const encoded = new TextEncoder().encode('안녕, 한글! 🇰🇷');
  const decoder = createTextStreamDecoder('utf-8');
  let actual = '';
  for (const byte of encoded) actual += decoder.decode(Uint8Array.of(byte));
  actual += decoder.flush();
  assert.equal(actual, '안녕, 한글! 🇰🇷');
});

test('EUC-KR streaming preserves Korean lead/trail bytes split between packets', () => {
  const decoder = createTextStreamDecoder('euc-kr');
  assert.equal(decoder.decode(Uint8Array.of(0xc7)), '');
  assert.equal(decoder.decode(Uint8Array.of(0xd1, 0xb1)), '한');
  assert.equal(decoder.decode(Uint8Array.of(0xdb)), '글');
  assert.equal(decoder.flush(), '');
});

test('stream decoders support Windows-1252, isolate directions, flush and reset predictably', () => {
  assert.equal(createTextStreamDecoder('windows-1252').decode(Uint8Array.of(0x80, 0xe9)), '€é');
  assert.throws(() => createTextStreamDecoder('unsupported'), /인코딩/);
  const rx = createTextStreamDecoder('utf-8');
  const tx = createTextStreamDecoder('utf-8');
  assert.equal(rx.decode(Uint8Array.of(0xed, 0x95)), '');
  assert.equal(tx.decode(new TextEncoder().encode('전송')), '전송');
  assert.equal(rx.decode(Uint8Array.of(0x9c)), '한');
  assert.equal(rx.decode(Uint8Array.of(0xea)), '');
  assert.equal(rx.flush(), '\ufffd');
  assert.equal(rx.decode(new TextEncoder().encode('끝')), '끝');
  rx.decode(Uint8Array.of(0xea));
  rx.reset();
  assert.equal(rx.decode(new TextEncoder().encode('새')), '새');
  assert.equal(rx.flush(), '');
});

test('byte and timestamp formatters have stable readable output', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1), '1 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1024), '1 KiB');
  assert.equal(formatBytes(1536), '1.5 KiB');
  assert.equal(formatBytes(1048576), '1 MiB');
  assert.equal(formatBytes(-1), '0 B');
  assert.equal(formatBytes(NaN), '0 B');
  assert.equal(formatBytes(Infinity), '0 B');
  assert.equal(formatTimestamp(new Date(2026, 8, 2, 3, 4, 5, 6)), '03:04:05.006');
  assert.equal(formatTimestamp(new Date('invalid')), '--:--:--.---');
});

test('history is newest-first, deduplicated by exact content/mode/ending, and immutable', () => {
  const source = [historyEntry('AT'), historyEntry('AT+GMR'), historyEntry('AT', { hex: true }), historyEntry('AT', { lineEnding: 'crlf' })];
  const before = JSON.stringify(source);
  const latest = historyEntry('AT', { time: '2026-09-02T02:00:00Z' });
  const actual = addHistory(source, latest);
  assert.equal(actual.length, 4);
  assert.deepEqual(actual[0], { ...latest, time: '2026-09-02T02:00:00.000Z' });
  assert.equal(actual[1].content, 'AT+GMR');
  assert.equal(actual[2].hex, true);
  assert.equal(actual[3].lineEnding, 'crlf');
  assert.equal(JSON.stringify(source), before);
  actual[1].content = '수정';
  assert.equal(source[1].content, 'AT+GMR');
});

test('history normalizes legacy entries, bounds memory and drops malformed stored records', () => {
  const history = Array.from({ length: 60 }, (_, index) => historyEntry(`명령 ${index}`));
  assert.equal(addHistory(history, historyEntry('새 명령')).length, 30);
  assert.equal(addHistory(history, historyEntry('새 명령'), 2).length, 2);
  assert.deepEqual(addHistory(history, historyEntry('새 명령'), 0), []);
  assert.deepEqual(addHistory([null, {}, 1, { content: {}, hex: false }, historyEntry('정상')], null), [historyEntry('정상')]);
  assert.deepEqual(addHistory([], { command: 'AT', hex: false, ending: 'crlf', time: 0 }), [historyEntry('AT', { lineEnding: 'crlf', time: '1970-01-01T00:00:00.000Z' })]);
  assert.throws(() => addHistory([], { content: 42 }), /전송 기록/);
  assert.throws(() => addHistory([], historyEntry('x'.repeat(65537))), /전송 기록/);
});

test('optional imported history is validated, normalized and bounded with the rest of the config', () => {
  const actual = parseImportedConfig(validConfig({ history: [historyEntry('AT'), historyEntry('AT'), historyEntry('안녕', { lineEnding: 'lf', time: 0 })] }));
  assert.deepEqual(actual.history, [historyEntry('AT'), historyEntry('안녕', { lineEnding: 'lf', time: '1970-01-01T00:00:00.000Z' })]);
  for (const history of ['not-an-array', {}, Array(1), [null], [{ content: 'AT', hex: 'false' }], [historyEntry('AT', { lineEnding: 'bogus' })]]) {
    assert.throws(() => parseImportedConfig(validConfig({ history })), /전송 기록/);
  }
});
