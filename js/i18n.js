/* Local UI translations only. Device bytes, saved commands and scripts are data. */
;(function () {
    'use strict'
    const KEY = 'web-serial-debug:language'
    const choices = ['auto', 'ko', 'en', 'zh-CN']
    const catalog = window.SerialMessages
    const bindings = []
    let preference = 'auto', language = 'ko', initialized = false
    const normalize = (value) => String(value || '').toLowerCase().split('-')[0]
    function browserLanguage() {
        for (const value of navigator.languages || [navigator.language]) {
            const base = normalize(value)
            if (base === 'ko' || base === 'en') return base
            if (base === 'zh') return 'zh-CN'
        }
        return 'en'
    }
    function render(value, values) {
        if (value && typeof value === 'object' && typeof value.key === 'string') return render(value.key, value.values)
        const key = String(value ?? '')
        const translated = language === 'ko' ? key : catalog[key]?.[language] ?? key
        // Replace once: placeholder-like text in user data is never interpreted.
        return translated.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (token, name) => Object.hasOwn(values || {}, name) ? String(values[name] && typeof values[name] === 'object' && typeof values[name].key === 'string' ? render(values[name]) : values[name]) : token)
    }
    function message(key, values = {}) {
        return Object.freeze({ key, values, toString() { return render(key, values) } })
    }
    function error(value) {
        if (typeof value === 'string') value = message(value)
        const result = new Error(String(value))
        result.localizedMessage = value
        return result
    }
    function apply() {
        language = preference === 'auto' ? browserLanguage() : preference
        document.documentElement.lang = language
        for (const binding of bindings) {
            if (!binding.node.isConnected) continue
            const text = binding.prefix + render(binding.key) + binding.suffix
            if (binding.attribute) binding.node.setAttribute(binding.attribute, text)
            else binding.node.nodeValue = text
        }
        const select = document.getElementById('serial-language')
        if (select) select.value = preference
    }
    function setLanguage(value) {
        if (!choices.includes(value)) return false
        preference = value
        let saved = true
        try { localStorage.setItem(KEY, value) } catch (_) { saved = false }
        apply()
        window.dispatchEvent(new CustomEvent('serial-language-change', { detail: { language, preference, saved } }))
        return true
    }
    function init() {
        if (initialized) return
        initialized = true
        try {
            const saved = localStorage.getItem(KEY)
            if (choices.includes(saved)) preference = saved
        } catch (_) { /* The selector still works for this tab without storage. */ }
        function bind(node, source, attribute) {
            const key = source.trim()
            if (!Object.hasOwn(catalog, key)) return
            bindings.push({ node, attribute, key, prefix: source.slice(0, source.indexOf(key)), suffix: source.slice(source.indexOf(key) + key.length) })
        }
        // Snapshot authored markup exactly once, before common.js creates user
        // content. No MutationObserver, innerHTML, or rescanning of runtime data.
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
        while (walker.nextNode()) {
            const node = walker.currentNode
            if (!node.parentElement.closest('script, style, textarea, pre, code, noscript, [translate="no"]')) bind(node, node.nodeValue)
        }
        for (const element of document.querySelectorAll('[title], [aria-label], [placeholder], meta[name="description"]')) {
            if (element.closest('[translate="no"]')) continue
            for (const attribute of ['title', 'aria-label', 'placeholder']) if (element.hasAttribute(attribute)) bind(element, element.getAttribute(attribute), attribute)
            if (element.matches('meta[name="description"]')) bind(element, element.content, 'content')
        }
        apply()
        document.getElementById('serial-language')?.addEventListener('change', (event) => setLanguage(event.target.value))
        window.addEventListener('languagechange', () => {
            if (preference !== 'auto') return
            apply()
            window.dispatchEvent(new CustomEvent('serial-language-change', { detail: { language, preference, saved: true } }))
        })
    }
    window.SerialI18n = Object.freeze({ t: render, message, error, init, setLanguage, get language() { return language }, get preference() { return preference }, storageKey: KEY })
    init()
})()
