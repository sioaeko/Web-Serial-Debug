const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { JSDOM } = require('jsdom');
const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const KEY = 'web-serial-debug:language';

test('link preview descriptions stay English in static HTML and every UI language', (t) => {
  const w = fixture(t, ['ko']);
  const selectors = ['meta[name="description"]', 'meta[property="og:description"]', 'meta[name="twitter:description"]'];
  const expected = 'A browser-based serial debugger with FUNSR PRO settings, saved commands, and text/HEX logs. Available in English, Korean, and Simplified Chinese.';
  const staticDom = new JSDOM(read('index.html'));
  t.after(() => staticDom.window.close());
  for (const selector of selectors) assert.equal(staticDom.window.document.querySelector(selector).content, expected);
  for (const language of ['ko', 'en', 'zh-CN', 'auto']) {
    w.SerialI18n.setLanguage(language);
    for (const selector of selectors) assert.equal(w.document.querySelector(selector).content, expected);
  }
  assert.equal(w.document.querySelector('meta[property="og:url"]').content, 'https://sioaeko.github.io/Web-Serial-Debug/');
  for (const selector of ['meta[property="og:title"]', 'meta[name="twitter:title"]']) assert.equal(w.document.querySelector(selector).content, 'Web Serial Debug');
});

function fixture(t, languages = ['en-US'], stored, blocked = false) {
  const dom = new JSDOM(read('index.html'), { url: 'https://locale.invalid/Web-Serial-Debug/', runScripts: 'outside-only' });
  const w = dom.window;
  Object.defineProperty(w.navigator, 'languages', { value: languages, configurable: true });
  if (stored !== undefined) w.localStorage.setItem(KEY, stored);
  if (blocked) Object.defineProperty(w, 'localStorage', { get() { throw new Error('Storage blocked'); } });
  w.eval(read('js/messages.js'));
  w.eval(read('js/i18n.js'));
  t.after(() => w.close());
  return w;
}

test('all authored UI and validation strings have complete translations with matching placeholders', (t) => {
  const w = fixture(t, ['ko']);
  const keys = new Set();
  const walker = w.document.createTreeWalker(w.document.body, w.NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node.parentElement.closest('script, style, textarea, pre, code, noscript, [translate="no"]') && /[가-힣]/.test(node.nodeValue)) keys.add(node.nodeValue.trim());
  }
  for (const element of w.document.querySelectorAll('[title], [aria-label], [placeholder], meta[name="description"]')) {
    for (const name of ['title', 'aria-label', 'placeholder', 'content']) {
      const value = element.getAttribute(name);
      if (value && /[가-힣]/.test(value)) keys.add(value.trim());
    }
  }
  for (const file of ['js/common.js', 'js/serial-utils.js']) {
    for (const line of read(file).split(/\r?\n/)) {
      if (line.trimStart().startsWith('//') || line.includes('const defaultCode')) continue;
      for (const match of line.matchAll(/'(?:\\.|[^'\\\r\n])*'|"(?:\\.|[^"\\\r\n])*"/g)) {
        if (/[가-힣]/.test(match[0])) keys.add(vm.runInNewContext(match[0]));
      }
    }
  }
  const placeholders = (text) => [...text.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map((match) => match[1]).sort();
  assert.ok(keys.size > 350, 'Audit covers static and dynamic copy, not a sample');
  for (const key of keys) assert.ok(w.SerialMessages[key], 'Missing key: ' + key);
  for (const [key, translations] of Object.entries(w.SerialMessages)) {
    for (const locale of ['en', 'zh-CN']) {
      assert.ok(translations[locale]?.trim(), key + ': ' + locale);
      assert.doesNotMatch(translations[locale], /[가-힣]/, key);
      assert.deepEqual(placeholders(translations[locale]), placeholders(key), key);
    }
  }
});

for (const [languages, expected] of [
  [['ko-KR'], 'ko'], [['en-GB'], 'en'], [['zh-TW'], 'zh-CN'],
  [['fr', 'zh-CN'], 'zh-CN'], [['ja'], 'en'], [[], 'en'],
]) test('automatic locale: ' + JSON.stringify(languages), (t) => {
  const w = fixture(t, languages);
  assert.equal(w.SerialI18n.language, expected);
  assert.equal(w.document.documentElement.lang, expected);
  assert.equal(w.document.getElementById('serial-language').value, 'auto');
});

test('explicit language persists, unsupported preferences are ignored, auto follows browser changes', (t) => {
  const w = fixture(t, ['en'], 'ko');
  assert.equal(w.SerialI18n.language, 'ko');
  w.SerialI18n.setLanguage('zh-CN');
  assert.equal(w.localStorage.getItem(KEY), 'zh-CN');
  const reloaded = fixture(t, ['en'], w.localStorage.getItem(KEY));
  assert.equal(reloaded.SerialI18n.language, 'zh-CN');
  assert.equal(w.SerialI18n.setLanguage('invalid'), false);
  assert.equal(w.SerialI18n.language, 'zh-CN');
  Object.defineProperty(w.navigator, 'languages', { value: ['ko'] });
  w.dispatchEvent(new w.Event('languagechange'));
  assert.equal(w.SerialI18n.language, 'zh-CN');
  w.SerialI18n.setLanguage('auto');
  assert.equal(w.SerialI18n.language, 'ko');
  Object.defineProperty(w.navigator, 'languages', { value: ['en'] });
  w.dispatchEvent(new w.Event('languagechange'));
  assert.equal(w.SerialI18n.language, 'en');
  assert.equal(fixture(t, ['en'], '<script>').SerialI18n.preference, 'auto');
});

test('blocked storage does not prevent language selection and reports persistence failure', (t) => {
  const w = fixture(t, ['ko'], undefined, true);
  let detail;
  w.addEventListener('serial-language-change', (event) => { detail = event.detail; });
  assert.equal(w.SerialI18n.setLanguage('en'), true);
  assert.equal(w.document.documentElement.lang, 'en');
  assert.equal(detail.saved, false);
});

test('translation never scans runtime data or recursively interpolates user strings', (t) => {
  const w = fixture(t, ['ko']);
  const node = w.document.createElement('p');
  node.textContent = '연결됨 {name} <img src=x>';
  w.document.body.append(node);
  const script = w.document.querySelector('textarea').value;
  w.SerialI18n.setLanguage('en');
  assert.equal(node.textContent, '연결됨 {name} <img src=x>');
  assert.equal(w.document.querySelector('textarea').value, script);
  const value = w.SerialI18n.message('{name} 명령 전송', { name: '<img> {name} 연결됨' });
  assert.equal(String(value), 'Send command: <img> {name} 연결됨');
  assert.ok(w.document.querySelector('label[for="serial-language"]').textContent.includes('Language'));
  assert.deepEqual([...w.document.querySelectorAll('#serial-language option[translate="no"]')].map((o) => o.textContent), ['한국어', 'English', '简体中文']);
});
