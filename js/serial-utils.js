/* Pure data helpers shared by the browser app and the Node.js regression tests. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.SerialUtils = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_SERIAL_OPTIONS = Object.freeze({
    baudRate: 115200,
    dataBits: 8,
    stopBits: 1,
    parity: 'none',
    bufferSize: 1024,
    flowControl: 'none',
  });

  const DEFAULT_TOOL_OPTIONS = Object.freeze({
    autoScroll: true,
    showTime: true,
    logType: 'text',
    timeOut: 50,
    lineEnding: 'none',
    hexSend: false,
    loopSend: false,
    loopSendTime: 1000,
    sendContent: '',
    quickSendIndex: 0,
    encoding: 'utf-8',
    autoReconnect: false,
    wrap: true,
    logLimit: 2000,
    theme: 'system',
    preset: 'custom',
  });

  const LIMITS = Object.freeze({
    maxGroups: 50,
    maxItemsPerGroup: 200,
    maxTotalItems: 1000,
    maxNameLength: 120,
    maxContentLength: 65536,
    maxQuickTextLength: 1048576,
    maxCodeLength: 262144,
    maxConfigLength: 2097152,
    maxHistoryItems: 100,
  });

  const LINE_ENDINGS = Object.freeze({ none: [], lf: [10], cr: [13], crlf: [13, 10] });
  const TOOL_ENUMS = Object.freeze({
    logType: ['text', 'hex', 'hex&text', 'ansi'],
    lineEnding: ['none', 'lf', 'cr', 'crlf'],
    encoding: ['utf-8', 'euc-kr', 'windows-1252'],
    theme: ['system', 'light', 'dark'],
    preset: ['custom', 'arduino', 'esp32', 'modbus'],
  });
  const BOOLEAN_OPTIONS = ['autoScroll', 'showTime', 'hexSend', 'loopSend', 'autoReconnect', 'wrap'];
  const NUMBER_OPTIONS = Object.freeze({
    timeOut: [0, 5000],
    loopSendTime: [100, 3600000],
    quickSendIndex: [0, LIMITS.maxGroups - 1],
    logLimit: [100, 10000],
  });
  const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

  function isRecord(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function requireRecord(value, label) {
    if (!isRecord(value)) throw new TypeError(`${label}은(는) 올바른 객체여야 합니다.`);
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || FORBIDDEN_KEYS.has(key) || !own(descriptor, 'value')) {
        throw new TypeError(`${label}에 허용되지 않는 속성이 있습니다.`);
      }
    }
    return value;
  }

  function requireDenseArray(value, label, minimum, maximum) {
    if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
      throw new RangeError(`${label}은(는) ${minimum}~${maximum}개의 배열이어야 합니다.`);
    }
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (key === 'length') continue;
      if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length || !own(descriptor, 'value')) {
        throw new TypeError(`${label}에 허용되지 않는 속성이 있습니다.`);
      }
    }
    for (let index = 0; index < value.length; index += 1) {
      if (!own(value, index)) throw new TypeError(`${label}에 비어 있는 항목이 있습니다.`);
    }
    return value;
  }

  function finiteNumber(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value !== 'string') return null;
    const text = value.trim();
    // Decimal form values only: no Boolean, empty-string, hexadecimal or object coercion.
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return null;
    const number = Number(text);
    return Number.isFinite(number) ? number : null;
  }

  function integerInRange(value, minimum, maximum, label) {
    const number = finiteNumber(value);
    if (number === null || !Number.isInteger(number) || number < minimum || number > maximum) {
      throw new RangeError(`${label}은(는) ${minimum.toLocaleString('ko-KR')}~${maximum.toLocaleString('ko-KR')} 범위의 정수여야 합니다.`);
    }
    return number;
  }

  function clampedInteger(value, fallback, minimum, maximum) {
    const number = finiteNumber(value);
    return number === null ? fallback : Math.min(maximum, Math.max(minimum, Math.trunc(number)));
  }

  function enumValue(value, allowed, label) {
    if (!allowed.includes(value)) throw new RangeError(`${label} 값이 올바르지 않습니다.`);
    return value;
  }

  function asBytes(value) {
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (Array.isArray(value)) {
      for (const byte of value) {
        if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
          throw new TypeError('바이트는 0~255 범위의 정수여야 합니다.');
        }
      }
      return Uint8Array.from(value);
    }
    throw new TypeError('바이트 배열 또는 버퍼가 필요합니다.');
  }

  function parseHex(value) {
    if (typeof value !== 'string') throw new TypeError('HEX 입력은 문자열이어야 합니다.');
    const text = value.trim();
    if (text === '') return new Uint8Array();
    const bytes = [];
    // Do not discard empty tokens: repeated or trailing commas are malformed input.
    const tokens = text.split(/\s*,\s*|\s+/);
    for (const token of tokens) {
      if (/^0x[\da-f]{2}$/i.test(token)) {
        bytes.push(Number.parseInt(token.slice(2), 16));
        continue;
      }
      if (!/^[\da-f]+$/i.test(token)) {
        throw new Error('HEX에는 0~9, A~F와 공백·쉼표만 입력하세요. 0x 접두사는 바이트마다 붙여 주세요.');
      }
      if (token.length % 2 !== 0) throw new Error('HEX는 두 자리씩 입력해 주세요. 예: 48 65 또는 4865');
      for (let index = 0; index < token.length; index += 2) {
        bytes.push(Number.parseInt(token.slice(index, index + 2), 16));
      }
    }
    return Uint8Array.from(bytes);
  }

  function bytesToHex(value) {
    return Array.from(asBytes(value), (byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ');
  }

  function appendLineEnding(value, ending = 'none') {
    enumValue(ending, TOOL_ENUMS.lineEnding, '줄바꿈');
    const bytes = asBytes(value);
    const suffix = LINE_ENDINGS[ending];
    const result = new Uint8Array(bytes.byteLength + suffix.length);
    result.set(bytes);
    result.set(suffix, bytes.byteLength);
    return result;
  }

  const FUNSR_KP_LIMITS = Object.freeze({ min: 0.5, max: 5, step: 0.1, defaultValue: 1.2 });

  function validateFunsrKp(value) {
    let number;
    if (typeof value === 'string') {
      const text = value.trim();
      if (text.length > 32 || !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(text)) {
        throw new TypeError('FUNSR PRO 설정값은 0.5~5.0 범위의 십진수로 입력해 주세요.');
      }
      const fraction = text.split('.')[1] || '';
      if (/[1-9]/.test(fraction.slice(1))) throw new RangeError('FUNSR PRO 설정값은 0.1 단위로 입력해 주세요.');
      number = Number(text);
    } else if (typeof value === 'number') {
      number = value;
    } else {
      throw new TypeError('FUNSR PRO 설정값은 숫자여야 합니다.');
    }
    if (!Number.isFinite(number) || number < FUNSR_KP_LIMITS.min || number > FUNSR_KP_LIMITS.max) {
      throw new RangeError('FUNSR PRO 설정값은 0.5~5.0 범위여야 합니다.');
    }
    const tenths = Math.round(number * 10);
    if (Math.abs(number * 10 - tenths) > 1e-9) throw new RangeError('FUNSR PRO 설정값은 0.1 단위로 입력해 주세요.');
    return tenths / 10;
  }

  function formatFunsrKpCommand(value) {
    return 'DKP' + validateFunsrKp(value).toFixed(1);
  }

  function buildFunsrKpPayload(value) {
    // The documented configuration command is ASCII and always ends in CRLF.
    // It is independent of the generic composer mode and line-ending setting.
    const command = formatFunsrKpCommand(value) + '\r\n';
    return Uint8Array.from(command, (character) => character.charCodeAt(0));
  }

  function createFunsrResponseParser() {
    const maxLineLength = 512;
    const maxEvents = 128;
    let line = '';
    let overflow = false;

    function parseLine(text) {
      const clean = text.trim();
      if (/^kp saved, please reboot!$/i.test(clean)) return { type: 'saved' };
      const updated = /^new kp is (\d+(?:\.\d+)?)!$/i.exec(clean);
      const boot = /^Motor global kp is (\d+(?:\.\d+)?)$/i.exec(clean);
      const match = updated || boot;
      if (!match) return null;
      const value = Number(match[1]);
      if (!Number.isFinite(value) || value < FUNSR_KP_LIMITS.min || value > FUNSR_KP_LIMITS.max) return null;
      // Reported values are observations, not drafts: do not round a device's
      // different value into the one requested by the user.
      return { type: updated ? 'new-kp' : 'boot', value };
    }

    return {
      push(value) {
        const input = typeof value === 'string' ? value : asBytes(value);
        const events = [];
        for (let index = 0; index < input.length; index += 1) {
          const character = typeof input === 'string' ? input[index] : input[index] < 128 ? String.fromCharCode(input[index]) : '\uFFFD';
          if (character === '\r' || character === '\n') {
            if (!overflow && line) {
              const event = parseLine(line);
              if (event) {
                if (events.length === maxEvents) events.shift();
                events.push(event);
              }
            }
            line = '';
            overflow = false;
          } else if (!overflow) {
            if (line.length >= maxLineLength) { line = ''; overflow = true; }
            else line += character;
          }
        }
        return events;
      },
      reset() { line = ''; overflow = false; },
    };
  }

  function validateSerialOptions(value = {}) {
    const input = requireRecord(value, '시리얼 설정');
    const read = (key) => own(input, key) ? input[key] : DEFAULT_SERIAL_OPTIONS[key];
    return {
      baudRate: integerInRange(read('baudRate'), 1, 4000000, '전송 속도'),
      dataBits: integerInRange(read('dataBits'), 7, 8, '데이터 비트'),
      stopBits: integerInRange(read('stopBits'), 1, 2, '정지 비트'),
      parity: enumValue(read('parity'), ['none', 'even', 'odd'], '패리티'),
      bufferSize: integerInRange(read('bufferSize'), 1, 16777216, '버퍼 크기'),
      flowControl: enumValue(read('flowControl'), ['none', 'hardware'], '흐름 제어'),
    };
  }

  function normalizeToolOptions(value = {}) {
    // Corrupt local preferences must not break startup. Imports receive stricter checks below.
    let input;
    try {
      input = requireRecord(value, '도구 설정');
    } catch {
      input = {};
    }
    const result = { ...DEFAULT_TOOL_OPTIONS };
    for (const key of BOOLEAN_OPTIONS) {
      if (own(input, key) && typeof input[key] === 'boolean') result[key] = input[key];
    }
    for (const [key, allowed] of Object.entries(TOOL_ENUMS)) {
      if (own(input, key) && allowed.includes(input[key])) result[key] = input[key];
    }
    for (const [key, range] of Object.entries(NUMBER_OPTIONS)) {
      if (own(input, key)) result[key] = clampedInteger(input[key], result[key], range[0], range[1]);
    }
    if (!own(input, 'lineEnding') && own(input, 'addCRLF') && input.addCRLF === true) result.lineEnding = 'crlf';
    if (own(input, 'sendContent') && typeof input.sendContent === 'string') result.sendContent = input.sendContent.slice(0, LIMITS.maxContentLength);
    // Loading or importing preferences must never replay commands on a device.
    result.loopSend = false;
    return result;
  }

  function boundedString(value, label, maximum, allowEmpty = true, trim = false) {
    if (typeof value !== 'string') throw new TypeError(`${label}은(는) 문자열이어야 합니다.`);
    const result = trim ? value.trim() : value;
    if ((!allowEmpty && result.length === 0) || result.length > maximum) {
      throw new RangeError(`${label}은(는) ${allowEmpty ? '0' : '1'}~${maximum.toLocaleString('ko-KR')}자여야 합니다.`);
    }
    return result;
  }

  function validateQuickSendList(groups) {
    requireDenseArray(groups, '빠른 전송 그룹', 1, LIMITS.maxGroups);
    let totalItems = 0;
    let totalText = 0;
    return groups.map((group) => {
      requireRecord(group, '빠른 전송 그룹');
      const name = boundedString(own(group, 'name') ? group.name : undefined, '빠른 전송 그룹 이름', LIMITS.maxNameLength, false, true);
      requireDenseArray(own(group, 'list') ? group.list : undefined, '빠른 전송 그룹의 명령 목록', 0, LIMITS.maxItemsPerGroup);
      totalItems += group.list.length;
      totalText += name.length;
      if (totalItems > LIMITS.maxTotalItems) throw new RangeError(`빠른 전송 명령은 전체 ${LIMITS.maxTotalItems}개를 넘을 수 없습니다.`);
      const list = group.list.map((item) => {
        requireRecord(item, '빠른 전송 명령');
        const itemName = boundedString(own(item, 'name') ? item.name : undefined, '빠른 전송 명령 이름', LIMITS.maxNameLength, false, true);
        const content = boundedString(own(item, 'content') ? item.content : undefined, '빠른 전송 내용', LIMITS.maxContentLength);
        if (own(item, 'hex') && typeof item.hex !== 'boolean') throw new TypeError('빠른 전송의 HEX 여부는 참 또는 거짓이어야 합니다.');
        totalText += itemName.length + content.length;
        if (totalText > LIMITS.maxQuickTextLength) throw new RangeError('빠른 전송 내용의 전체 크기가 너무 큽니다.');
        return { name: itemName, content, hex: own(item, 'hex') ? item.hex : false };
      });
      return { name, list };
    });
  }

  function parseJson(value, label) {
    if (value.length > LIMITS.maxConfigLength) throw new RangeError(`${label}의 크기가 너무 큽니다.`);
    try {
      return JSON.parse(value);
    } catch {
      throw new SyntaxError(`${label}의 JSON 형식이 올바르지 않습니다.`);
    }
  }

  function assertJsonData(value) {
    const active = new Set();
    let nodes = 0;
    let textLength = 0;
    function visit(item, depth) {
      nodes += 1;
      if (depth > 20 || nodes > 20000) throw new RangeError('설정 파일의 구조가 너무 복잡합니다.');
      if (typeof item === 'string') {
        textLength += item.length;
        if (textLength > LIMITS.maxConfigLength) throw new RangeError('설정 파일의 전체 크기가 너무 큽니다.');
        return;
      }
      if (item === null || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) return;
      if (typeof item !== 'object') throw new TypeError('설정 파일에 허용되지 않는 값이 있습니다.');
      if (active.has(item)) throw new TypeError('설정 파일에는 순환 참조를 사용할 수 없습니다.');
      const isArray = Array.isArray(item);
      if (!isArray) requireRecord(item, '설정 파일');
      active.add(item);
      for (const key of Reflect.ownKeys(item)) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (typeof key !== 'string' || FORBIDDEN_KEYS.has(key) || !own(descriptor, 'value')) {
          throw new TypeError('설정 파일에 허용되지 않는 속성이 있습니다.');
        }
        if (isArray && key === 'length') continue;
        textLength += key.length;
        if (textLength > LIMITS.maxConfigLength) throw new RangeError('설정 파일의 전체 크기가 너무 큽니다.');
        visit(descriptor.value, depth + 1);
      }
      active.delete(item);
    }
    visit(value, 0);
  }

  function validateImportedToolOptions(input) {
    requireRecord(input, '도구 설정');
    for (const key of [...BOOLEAN_OPTIONS, 'addCRLF']) {
      if (own(input, key) && typeof input[key] !== 'boolean') throw new TypeError(`도구 설정의 ${key} 값은 참 또는 거짓이어야 합니다.`);
    }
    for (const [key, allowed] of Object.entries(TOOL_ENUMS)) {
      if (own(input, key)) enumValue(input[key], allowed, `도구 설정의 ${key}`);
    }
    for (const key of Object.keys(NUMBER_OPTIONS)) {
      if (own(input, key) && finiteNumber(input[key]) === null) throw new TypeError(`도구 설정의 ${key} 값은 유효한 숫자여야 합니다.`);
    }
    if (own(input, 'sendContent')) boundedString(input.sendContent, '전송 내용', LIMITS.maxContentLength);
    return normalizeToolOptions(input);
  }

  function normalizeHistoryEntry(value) {
    requireRecord(value, '전송 기록');
    const content = boundedString(own(value, 'content') ? value.content : (own(value, 'command') ? value.command : undefined), '전송 기록의 내용', LIMITS.maxContentLength);
    const hex = own(value, 'hex') ? value.hex : false;
    if (typeof hex !== 'boolean') throw new TypeError('전송 기록의 HEX 여부는 참 또는 거짓이어야 합니다.');
    const lineEnding = own(value, 'lineEnding') ? value.lineEnding : (own(value, 'ending') ? value.ending : 'none');
    enumValue(lineEnding, TOOL_ENUMS.lineEnding, '전송 기록의 줄바꿈');
    const rawTime = own(value, 'time') ? value.time : Date.now();
    if (typeof rawTime !== 'string' && typeof rawTime !== 'number') throw new TypeError('전송 기록의 시간이 올바르지 않습니다.');
    const date = new Date(rawTime);
    if (!Number.isFinite(date.getTime())) throw new TypeError('전송 기록의 시간이 올바르지 않습니다.');
    return { content, hex, lineEnding, time: date.toISOString() };
  }

  function addHistory(history, entry = null, limit = 30) {
    const maximum = clampedInteger(limit, 30, 0, LIMITS.maxHistoryItems);
    const result = [];
    const seen = new Set();
    const insert = (item) => {
      const key = JSON.stringify([item.content, item.hex, item.lineEnding]);
      if (item.content === '' || seen.has(key) || result.length >= maximum) return;
      seen.add(key);
      result.push(item);
    };
    if (entry !== null && entry !== undefined) insert(normalizeHistoryEntry(entry));
    if (Array.isArray(history)) {
      for (const oldEntry of history) {
        if (result.length >= maximum) break;
        try {
          insert(normalizeHistoryEntry(oldEntry));
        } catch {
          // A single damaged local history row should not hide the remaining valid rows.
        }
      }
    }
    return result;
  }

  function parseImportedConfig(value) {
    const input = typeof value === 'string' ? parseJson(value, '설정 파일') : value;
    assertJsonData(input);
    requireRecord(input, '설정 파일');
    const required = ['serialOptions', 'toolOptions', 'quickSendList', 'code'];
    if (required.some((key) => !own(input, key))) throw new TypeError('올바른 설정 파일이 아닙니다. 시리얼·도구·빠른 전송·스크립트 설정이 모두 필요합니다.');
    const versioned = own(input, 'schemaVersion');
    if (versioned && input.schemaVersion !== 1) throw new RangeError('지원하지 않는 설정 파일 버전입니다.');

    function field(key, fallback) {
      let result = input[key];
      if (!versioned && typeof result === 'string') result = parseJson(result, key);
      if (!versioned && result === null) return fallback;
      assertJsonData(result);
      return result;
    }

    // Validate everything before returning. This function never touches storage or runs code.
    const serialOptions = validateSerialOptions(field('serialOptions', {}));
    const toolOptions = validateImportedToolOptions(field('toolOptions', {}));
    const quickSendList = validateQuickSendList(field('quickSendList', [{ name: '기본 명령', list: [] }]));
    const code = boundedString(!versioned && input.code === null ? '' : input.code, '스크립트', LIMITS.maxCodeLength);
    toolOptions.quickSendIndex = Math.min(toolOptions.quickSendIndex, quickSendList.length - 1);
    const result = { serialOptions, toolOptions, quickSendList, code };
    if (own(input, 'history')) {
      const history = field('history', []);
      requireDenseArray(history, '전송 기록', 0, LIMITS.maxHistoryItems);
      for (const entry of history) normalizeHistoryEntry(entry);
      result.history = addHistory(history, null);
    }
    return result;
  }

  function createTextStreamDecoder(encoding = 'utf-8') {
    enumValue(encoding, TOOL_ENUMS.encoding, '수신 인코딩');
    const create = () => {
      try {
        return new TextDecoder(encoding, { fatal: false });
      } catch {
        throw new Error('이 브라우저에서 선택한 인코딩을 지원하지 않습니다.');
      }
    };
    let decoder = create();
    return {
      decode(bytes) { return decoder.decode(asBytes(bytes), { stream: true }); },
      flush() {
        const text = decoder.decode();
        decoder = create();
        return text;
      },
      reset() { decoder = create(); },
    };
  }

  function formatBytes(value) {
    const number = finiteNumber(value);
    if (number === null || number <= 0) return '0 B';
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
    const exponent = Math.min(Math.floor(Math.log(number) / Math.log(1024)), units.length - 1);
    if (exponent <= 0) return `${Math.floor(number)} B`;
    return `${Number((number / (1024 ** exponent)).toFixed(2))} ${units[exponent]}`;
  }

  function formatTimestamp(value = new Date()) {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) return '--:--:--.---';
    const two = (number) => String(number).padStart(2, '0');
    return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3, '0')}`;
  }

  return Object.freeze({
    DEFAULT_SERIAL_OPTIONS,
    DEFAULT_TOOL_OPTIONS,
    LIMITS,
    parseHex,
    bytesToHex,
    appendLineEnding,
    FUNSR_KP_LIMITS,
    validateFunsrKp,
    formatFunsrKpCommand,
    buildFunsrKpPayload,
    createFunsrResponseParser,
    validateSerialOptions,
    normalizeToolOptions,
    validateQuickSendList,
    parseImportedConfig,
    createTextStreamDecoder,
    formatBytes,
    formatTimestamp,
    addHistory,
  });
});
