/* Web Serial Debug KR — based on itldg/web-serial-debug (Apache-2.0; see LICENSE).
 * KR modifications: Korean UI, validated persistence, explicit connections,
 * bounded logs, safe rendering, history, stream cleanup and FUNSR PRO DKP. */
;(function () {
    'use strict'
    const U = window.SerialUtils
    const $ = (id) => document.getElementById(id)
    const on = (id, type, handler) => $(id)?.addEventListener(type, handler)
    const logs = $('serial-logs')
    if (!logs || !U) {
        if ($('serial-status')) $('serial-status').textContent = '필수 파일을 불러오지 못했습니다. 페이지를 새로고침해 주세요.'
        return
    }
    const CONFIG_KEY = 'web-serial-debug-kr:config:v1'
    const HISTORY_KEY = 'web-serial-debug-kr:history:v1'
    const THEME_KEY = 'web-serial-debug-kr:theme'
    const MAX_LOG_BYTES = 4 * 1024 * 1024
    const MAX_ENTRY = 16 * 1024
    const MAX_SEND = 64 * 1024
    const MAX_FILE = 2 * 1024 * 1024
    const MAX_CODE = 256 * 1024
    const FUNSR_ACK_TIMEOUT = 8000
    const encoder = new TextEncoder()
    const supported = Boolean(window.isSecureContext && navigator.serial)
    const hardwareFields = { baudRate: 'serial-baud', dataBits: 'serial-data-bits', stopBits: 'serial-stop-bits', parity: 'serial-parity', bufferSize: 'serial-buffer-size', flowControl: 'serial-flow-control' }
    const defaultQuick = [{ name: 'ESP32 · 상태 조회', list: [
        { name: 'AT 응답 확인', content: 'AT', hex: false },
        { name: '펌웨어 버전', content: 'AT+GMR', hex: false },
        { name: '지원 명령 조회', content: 'AT+CMD?', hex: false },
        { name: 'UART 설정 조회', content: 'AT+UART_CUR?', hex: false },
        { name: '절전 상태 조회', content: 'AT+SLEEP?', hex: false },
        { name: '메모리 상태 조회', content: 'AT+SYSRAM?', hex: false },
        { name: '시스템 메시지 조회', content: 'AT+SYSMSG?', hex: false },
    ] }]
    const defaultCode = $('serial-code-content')?.value || "postMessage({type:'log',data:'스크립트 준비 완료. 자동 전송하지 않습니다.'});"
    let options = U.validateSerialOptions({}), prefs = U.normalizeToolOptions({})
    let groups = structuredClone(defaultQuick), code = defaultCode, history = []
    let validGroups = structuredClone(defaultQuick)
    let editor = null, codeSaveTimer = null
    let configBlocked = false, historyBlocked = false, storageWarned = false, ready = false
    const startupWarnings = []
    let port = null, opened = false, mayBeOpen = false, busy = false, selecting = false, closeFailed = false
    let reader = null, readTask = null, closeTask = null, activeWriter = null
    let writeTail = Promise.resolve(), pendingWrites = 0, epoch = 0, reconnectArmed = false, manuallyClosed = true
    let statusText = supported ? '포트를 선택한 뒤 연결을 열어 주세요.' : unsupportedText()
    let entries = [], logBytes = 0, nextId = 1, rxCount = 0, txCount = 0
    let paused = false, fullRender = true, scheduled = false, renderedId = 0, visibleCount = 0
    let search = '', direction = 'all'
    let decoder = U.createTextStreamDecoder('utf-8'), rxParts = [], rxLength = 0, rxStart = 0, rxTimer = null
    let sessionStart = null, sessionElapsed = 0
    let loopTimer = null, loopActive = false, loopRecord = null, loopEpoch = 0, sending = false
    let historyCursor = -1, historyDraft = null, composing = false
    let worker = null, workerURL = null, workerWindow = 0, workerMessages = 0, workerBytes = 0
    const funsrParser = U.createFunsrResponseParser()
    let funsrDraft = 1.2, funsrLastDraft = 1.2, funsrDraftError = ''
    let funsrConfirmed = false, funsrReported = null, funsrPending = null, funsrOutcome = null, funsrAckTimer = null
    const tipModal = window.bootstrap?.Modal && $('model-tip') ? new bootstrap.Modal($('model-tip')) : null
    const nameModal = window.bootstrap?.Modal && $('model-change-name') ? new bootstrap.Modal($('model-change-name')) : null

    function unsupportedText() {
        return window.isSecureContext
            ? '이 브라우저는 시리얼 연결을 지원하지 않습니다. 실제 연결에는 데스크톱 Chrome·Edge를 사용해 주세요.'
            : '시리얼 연결에는 HTTPS 또는 localhost가 필요합니다. 안전한 주소로 다시 접속해 주세요.'
    }
    function message(text, title = 'Web Serial Debug KR') {
        if (tipModal) {
            $('modal-title').textContent = title
            $('modal-message').textContent = String(text).slice(0, 4000)
            tipModal.show()
        } else window.alert(String(text).slice(0, 4000))
    }
    function errorText(error) {
        const known = {
            NotAllowedError: '브라우저 또는 운영체제에서 권한을 허용하지 않았습니다.',
            SecurityError: '사이트의 시리얼 접근 권한을 확인해 주세요.',
            NetworkError: '장치 연결 또는 통신 상태를 확인해 주세요.',
            InvalidStateError: '포트가 다른 작업에 사용 중이거나 현재 상태에서 작업할 수 없습니다.',
            NotSupportedError: '이 장치 또는 브라우저가 해당 설정을 지원하지 않습니다.',
            AbortError: '작업이 취소되었습니다.',
        }
        return known[error?.name] || String(error?.message || error || '알 수 없는 오류').slice(0, 500)
    }
    function storageWarning() {
        if (storageWarned) return
        storageWarned = true
        const text = '브라우저 저장 공간을 사용할 수 없어 변경 사항이 이번 탭에서만 유지됩니다. 저장 공간·개인정보 보호 설정을 확인해 주세요.'
        if (ready) systemLog(text); else startupWarnings.push(text)
    }
    function readStorage(key) { try { return localStorage.getItem(key) } catch (_) { storageWarning(); return null } }
    function writeStorage(key, value) { try { localStorage.setItem(key, value); return true } catch (_) { storageWarning(); return false } }
    function normalizedHistory(value) {
        if (!Array.isArray(value)) throw new Error('전송 기록은 배열이어야 합니다.')
        const clean = [], seen = new Set()
        for (const item of value.slice(0, 1000)) {
            if (!item || typeof item.content !== 'string' || !item.content.length || item.content.length > MAX_SEND || typeof item.hex !== 'boolean' || !['none', 'lf', 'cr', 'crlf'].includes(item.lineEnding)) continue
            try {
                const bytes = item.hex ? U.parseHex(item.content) : U.appendLineEnding(encoder.encode(item.content), item.lineEnding)
                if (!bytes.length || bytes.length > MAX_SEND) continue
            } catch (_) { continue }
            const key = JSON.stringify([item.content, item.hex, item.lineEnding])
            if (seen.has(key)) continue
            seen.add(key)
            const date = new Date(item.time || 0)
            clean.push({ content: item.content, hex: item.hex, lineEnding: item.lineEnding, time: Number.isFinite(date.getTime()) ? date.toISOString() : new Date(0).toISOString() })
            if (clean.length === 30) break
        }
        return clean
    }
    function envelope(withHistory = false) {
        const value = { schemaVersion: 1, serialOptions: { ...options }, toolOptions: { ...prefs, loopSend: false }, quickSendList: groups, code }
        if (withHistory) value.history = history
        return value
    }
    function saveConfig() { if (!configBlocked) writeStorage(CONFIG_KEY, JSON.stringify(envelope())) }
    function loadConfig() {
        const current = readStorage(CONFIG_KEY)
        if (current !== null) {
            try {
                const value = U.parseImportedConfig(JSON.parse(current))
                options = value.serialOptions; prefs = value.toolOptions; groups = value.quickSendList; code = value.code
            } catch (error) {
                configBlocked = true
                startupWarnings.push('저장된 설정을 읽지 못해 임시 기본값을 사용합니다. 기존 데이터는 지우지 않았습니다. 설정 가져오기 또는 초기화로 복구할 수 있습니다. ' + errorText(error))
            }
        } else {
            const legacy = { serialOptions: readStorage('serialOptions'), toolOptions: readStorage('toolOptions'), quickSendList: readStorage('quickSendList'), code: readStorage('code') }
            if (Object.values(legacy).some((value) => value !== null)) {
                try {
                    const value = U.parseImportedConfig(legacy)
                    options = value.serialOptions; prefs = value.toolOptions
                    groups = legacy.quickSendList === null ? structuredClone(defaultQuick) : value.quickSendList
                    code = legacy.code === null ? defaultCode : value.code
                    saveConfig()
                    startupWarnings.push('이전 버전의 설정을 검증해 가져왔습니다. 원래 저장 데이터는 보관됩니다. 자동 전송은 시작하지 않습니다.')
                } catch (error) {
                    configBlocked = true
                    startupWarnings.push('이전 설정 형식이 올바르지 않아 임시 기본값을 사용합니다. 기존 데이터는 지우지 않았습니다. ' + errorText(error))
                }
            }
        }
        prefs.loopSend = false
        prefs.quickSendIndex = Math.min(Math.max(0, Number(prefs.quickSendIndex) || 0), groups.length - 1)
        const saved = readStorage(HISTORY_KEY)
        if (saved !== null) {
            try { history = normalizedHistory(JSON.parse(saved)) } catch (_) {
                historyBlocked = true
                startupWarnings.push('저장된 전송 기록을 읽지 못했습니다. 기존 데이터는 유지합니다. 기록 지우기를 누르면 새 기록을 저장할 수 있습니다.')
            }
        }
        const theme = readStorage(THEME_KEY)
        if (['light', 'dark'].includes(theme)) prefs.theme = theme
        decoder = U.createTextStreamDecoder(prefs.encoding)
    }
    function setPref(key, value) {
        const armed = key === 'loopSend' ? Boolean(value) : prefs.loopSend
        prefs = U.normalizeToolOptions({ ...prefs, [key]: value })
        prefs.loopSend = armed // Persisted state never restarts a loop.
        saveConfig()
    }
    function readOptions() {
        return U.validateSerialOptions(Object.fromEntries(Object.entries(hardwareFields).map(([key, id]) => [key, $(id).value])))
    }
    function applyHardware() { for (const [key, id] of Object.entries(hardwareFields)) if ($(id)) $(id).value = options[key] }
    function buttonLabel(id, text, icon, shortcut = '') {
        const button = $(id)
        if (!button) return
        button.replaceChildren()
        if (icon) {
            const symbol = document.createElement('i')
            symbol.className = 'bi ' + icon; symbol.setAttribute('aria-hidden', 'true'); button.appendChild(symbol)
        }
        if (text) button.appendChild(document.createTextNode(' ' + text + ' '))
        if (shortcut) { const key = document.createElement('kbd'); key.textContent = shortcut; button.appendChild(key) }
    }
    function applyTheme() {
        const theme = ['light', 'dark'].includes(prefs.theme) ? prefs.theme : window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
        document.documentElement.dataset.theme = theme
        if ($('serial-theme')) {
            buttonLabel('serial-theme', '', theme === 'dark' ? 'bi-sun' : 'bi-moon')
            $('serial-theme').title = theme === 'dark' ? '라이트 모드로 전환' : '다크 모드로 전환'
            $('serial-theme').setAttribute('aria-label', $('serial-theme').title)
            $('serial-theme').setAttribute('aria-pressed', String(theme === 'dark'))
        }
    }
    function applyPreferences() {
        const values = { 'serial-timer-out': prefs.timeOut, 'serial-log-type': prefs.logType, 'serial-line-ending': prefs.lineEnding, 'serial-loop-send-time': prefs.loopSendTime, 'serial-send-content': prefs.sendContent, 'serial-encoding': prefs.encoding, 'serial-log-limit': prefs.logLimit, 'serial-preset': prefs.preset }
        for (const [id, value] of Object.entries(values)) if ($(id)) $(id).value = value
        const checks = { 'serial-hex-send': prefs.hexSend, 'serial-loop-send': false, 'serial-show-time': prefs.showTime, 'serial-wrap': prefs.wrap, 'serial-auto-reconnect': prefs.autoReconnect }
        for (const [id, value] of Object.entries(checks)) if ($(id)) $(id).checked = Boolean(value)
        updateLogButtons(); applyTheme(); updateByteCount()
    }
    function connected() { return opened }
    function portInfo() {
        if (!port) return supported ? '아직 선택한 장치가 없습니다' : '이 브라우저에서 시리얼 연결을 지원하지 않습니다'
        try {
            const info = port.getInfo()
            if (info.usbVendorId !== undefined) return 'USB ' + info.usbVendorId.toString(16).toUpperCase().padStart(4, '0') + ':' + (info.usbProductId || 0).toString(16).toUpperCase().padStart(4, '0') + ' · 선택한 장치'
        } catch (_) { /* Disconnected devices may not expose info. */ }
        return '선택한 시리얼 장치'
    }
    function updateConnection() {
        const pending = busy || selecting
        const state = pending ? 'busy' : opened ? 'connected' : !supported ? 'unsupported' : port ? 'selected' : 'disconnected'
        if ($('serial-status')) { $('serial-status').textContent = statusText; $('serial-status').dataset.state = state }
        if ($('serial-connection-label')) $('serial-connection-label').textContent = pending ? '연결 작업 중' : opened ? '연결됨' : closeFailed ? '연결 상태 확인 필요' : port ? '포트 선택됨' : '연결 안 됨'
        if ($('serial-port-info')) $('serial-port-info').textContent = portInfo()
        if ($('serial-live-state')) { $('serial-live-state').textContent = paused ? '화면 일시정지' : opened ? '실시간 기록 중' : '연결 대기'; $('serial-live-state').dataset.state = state }
        if ($('serial-select-port')) $('serial-select-port').disabled = !supported || pending || opened || mayBeOpen
        if ($('serial-open-or-close')) {
            $('serial-open-or-close').disabled = !supported || pending || !port
            buttonLabel('serial-open-or-close', busy ? '연결 처리 중…' : opened ? '연결 해제' : closeFailed ? '닫기 재시도' : '연결하기', opened ? 'bi-x-lg' : 'bi-plug')
            $('serial-open-or-close').setAttribute('aria-pressed', String(opened))
        }
        for (const id of [...Object.values(hardwareFields), 'serial-preset']) if ($(id)) $(id).disabled = pending || opened || mayBeOpen
        if ($('serial-auto-reconnect')) $('serial-auto-reconnect').disabled = !supported
        document.querySelectorAll('.quick-send').forEach((button) => { button.disabled = !connected() || pending || Boolean(funsrPending) })
        updateSendButton(); updateCounters()
    }
    function status(text) { statusText = text; updateConnection() }
    function updateCounters() {
        if ($('serial-rx-count')) $('serial-rx-count').textContent = U.formatBytes(rxCount)
        if ($('serial-tx-count')) $('serial-tx-count').textContent = U.formatBytes(txCount)
        if ($('serial-log-count')) $('serial-log-count').textContent = entries.length.toLocaleString('ko-KR')
        const seconds = Math.max(0, Math.floor((sessionStart === null ? sessionElapsed : Date.now() - sessionStart) / 1000))
        const hours = Math.floor(seconds / 3600)
        const text = (hours ? String(hours).padStart(2, '0') + ':' : '') + String(Math.floor(seconds % 3600 / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0')
        if ($('serial-session-time')) $('serial-session-time').textContent = text
    }
    function startSession() { sessionStart = Date.now(); sessionElapsed = 0; updateCounters() }
    function finishSession() { if (sessionStart !== null) sessionElapsed = Date.now() - sessionStart; sessionStart = null; updateCounters() }
    function stripANSI(text) { return String(text).replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '') }
    function visibleText(text) { return String(text).replace(/\x00/g, '␀').replace(/\x1b/g, '␛') }
    function appendANSI(parent, text) {
        // Interpret fixed SGR styles only. Never insert device-provided HTML,
        // hyperlinks, OSC commands, URLs or arbitrary CSS into the document.
        const palette = ['#7b8496', '#f87171', '#4ade80', '#facc15', '#60a5fa', '#c084fc', '#22d3ee', '#cbd5e1']
        const clean = String(text).replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
        const regex = /\x1b\[([0-9;]*)m/g
        let offset = 0, color = '', bold = false, match
        const append = (part) => {
            if (!part) return
            const node = document.createElement('span')
            node.textContent = visibleText(stripANSI(part))
            if (color) node.style.color = color
            if (bold) node.style.fontWeight = '700'
            parent.appendChild(node)
        }
        while ((match = regex.exec(clean))) {
            append(clean.slice(offset, match.index))
            for (const value of (match[1] || '0').split(';').map(Number)) {
                if (value === 0) { color = ''; bold = false }
                else if (value === 1) bold = true
                else if (value === 22) bold = false
                else if (value === 39) color = ''
                else if (value >= 30 && value <= 37) color = palette[value - 30]
                else if (value >= 90 && value <= 97) color = palette[value - 90]
            }
            offset = regex.lastIndex
        }
        append(clean.slice(offset))
    }
    function trimLogs() {
        const limit = [500, 2000, 10000].includes(Number(prefs.logLimit)) ? Number(prefs.logLimit) : 2000
        while (entries.length > limit || logBytes > MAX_LOG_BYTES) {
            const entry = entries.shift()
            if (!entry) break
            logBytes -= entry.weight
        }
    }
    function addEntry(kind, bytes, text) {
        const raw = bytes ? Uint8Array.from(bytes) : null, body = String(text ?? '').slice(0, MAX_SEND)
        const entry = { id: nextId++, date: new Date(), direction: kind, bytes: raw, text: body, weight: (raw?.byteLength || 0) + body.length * 2 + 160 }
        entries.push(entry); logBytes += entry.weight; trimLogs(); updateCounters(); renderSoon()
    }
    function systemLog(text) { addEntry('system', null, String(text)) }
    function addBytes(bytes, kind) {
        const txDecoder = kind === 'tx' ? new TextDecoder('utf-8') : null
        for (let offset = 0; offset < bytes.length; offset += MAX_ENTRY) {
            const part = bytes.subarray(offset, Math.min(offset + MAX_ENTRY, bytes.length))
            addEntry(kind, part, kind === 'rx' ? decoder.decode(part) : txDecoder.decode(part, { stream: offset + MAX_ENTRY < bytes.length }))
        }
    }
    function matches(entry) {
        if (direction !== 'all' && entry.direction !== direction) return false
        return !search || stripANSI(entry.text).toLocaleLowerCase('ko-KR').includes(search) || Boolean(entry.bytes && U.bytesToHex(entry.bytes).toLowerCase().includes(search))
    }
    function logNode(entry) {
        const row = document.createElement('div'), time = document.createElement('span'), badge = document.createElement('span'), body = document.createElement('div')
        row.className = 'log-entry'; row.dataset.direction = entry.direction; row.dataset.logId = entry.id
        time.className = 'log-time'; time.textContent = U.formatTimestamp(entry.date); time.hidden = !prefs.showTime
        badge.className = 'log-direction'; badge.textContent = entry.direction === 'system' ? '안내' : entry.direction.toUpperCase()
        badge.setAttribute('aria-label', entry.direction === 'rx' ? '수신' : entry.direction === 'tx' ? '송신' : '시스템 안내')
        body.className = 'log-body'
        if (entry.direction === 'system') body.textContent = visibleText(entry.text)
        else {
            if (prefs.logType.includes('hex')) {
                const node = document.createElement('div'); node.className = 'log-hex'
                node.textContent = (prefs.logType === 'hex&text' ? 'HEX  ' : '') + U.bytesToHex(entry.bytes); body.appendChild(node)
            }
            if (prefs.logType.includes('text') || prefs.logType === 'ansi') {
                const node = document.createElement('div'); node.className = 'log-text'
                if (prefs.logType === 'ansi') appendANSI(node, entry.text)
                else node.textContent = (prefs.logType === 'hex&text' ? 'TXT  ' : '') + visibleText(entry.text)
                body.appendChild(node)
            }
        }
        row.append(time, badge, body)
        return row
    }
    function renderSoon(full = false) {
        if (full) fullRender = true
        if (paused || scheduled) return
        scheduled = true
        requestAnimationFrame(() => { scheduled = false; if (!paused) renderLogs() })
    }
    function renderLogs() {
        if (fullRender) { logs.replaceChildren(); renderedId = 0; visibleCount = 0; fullRender = false }
        else {
            const firstId = entries[0]?.id ?? nextId
            while (logs.firstElementChild && Number(logs.firstElementChild.dataset.logId) < firstId) { logs.firstElementChild.remove(); visibleCount-- }
        }
        const fragment = document.createDocumentFragment()
        for (const entry of entries) if (entry.id > renderedId && matches(entry)) { fragment.appendChild(logNode(entry)); visibleCount++ }
        if (entries.length) renderedId = entries[entries.length - 1].id
        logs.appendChild(fragment)
        logs.classList.toggle('no-wrap', !prefs.wrap); logs.classList.toggle('hide-time', !prefs.showTime); logs.classList.toggle('no-time', !prefs.showTime)
        const empty = $('serial-empty-state')
        if (empty) {
            empty.hidden = visibleCount > 0
            const title = empty.querySelector('[data-empty-title], h2, h3, strong'), description = empty.querySelector('[data-empty-description], p')
            if (title) title.textContent = entries.length ? '일치하는 로그가 없습니다' : '아직 수신한 데이터가 없습니다'
            if (description) description.textContent = entries.length ? '검색어나 송수신 필터를 바꿔 보세요.' : '포트를 선택하고 장치에 맞는 설정으로 연결해 주세요.'
        }
        if (prefs.autoScroll) logs.scrollTop = logs.scrollHeight
    }
    function updateLogButtons() {
        if ($('serial-auto-scroll')) { buttonLabel('serial-auto-scroll', prefs.autoScroll ? '자동 스크롤 켬' : '자동 스크롤 끔', 'bi-arrow-down'); $('serial-auto-scroll').setAttribute('aria-pressed', String(prefs.autoScroll)) }
        if ($('serial-pause')) {
            buttonLabel('serial-pause', paused ? '화면 재개' : '화면 일시정지', paused ? 'bi-play' : 'bi-pause')
            $('serial-pause').setAttribute('aria-pressed', String(paused))
            $('serial-pause').title = paused ? '보관된 로그를 화면에 다시 표시합니다' : '수신은 계속하고 화면 표시만 잠시 멈춥니다'
        }
        logs.classList.toggle('is-paused', paused)
    }
    function flushReceive() {
        clearTimeout(rxTimer); rxTimer = null
        if (!rxLength) return
        const joined = new Uint8Array(rxLength)
        let offset = 0
        for (const part of rxParts) { joined.set(part, offset); offset += part.length }
        rxParts = []; rxLength = 0; rxStart = 0
        addBytes(joined, 'rx')
        if (worker) {
            try { worker.postMessage({ type: 'uart_receive', data: Array.from(joined) }) }
            catch (error) { stopWorker(); systemLog('스크립트에 수신 데이터를 전달하지 못했습니다. ' + errorText(error)) }
        }
    }
    function receiveData(data) {
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
        receiveFunsr(bytes)
        rxCount += bytes.length
        for (let offset = 0; offset < bytes.length;) {
            if (!rxLength) rxStart = Date.now()
            const size = Math.min(MAX_ENTRY - rxLength, bytes.length - offset)
            rxParts.push(bytes.slice(offset, offset + size)); rxLength += size; offset += size
            if (rxLength >= MAX_ENTRY) flushReceive()
        }
        if (prefs.timeOut === 0 || (rxLength && Date.now() - rxStart >= 250)) flushReceive()
        else if (rxLength) {
            clearTimeout(rxTimer)
            rxTimer = setTimeout(flushReceive, Math.min(prefs.timeOut, Math.max(0, 250 - (Date.now() - rxStart))))
        }
        updateCounters()
    }
    function resetDecoder(flush = true) {
        if (flush) { flushReceive(); const tail = decoder.flush(); if (tail) addEntry('rx', new Uint8Array(), tail) }
        decoder = U.createTextStreamDecoder(prefs.encoding)
    }

    function updateFunsr() {
        const apply = $('funsr-speed-apply'), statusNode = $('funsr-speed-status')
        const hasDraft = funsrDraft !== null && !funsrDraftError
        const blocked = loopActive || Boolean(worker) || sending || pendingWrites > 0
        if ($('funsr-speed-command')) $('funsr-speed-command').textContent = hasDraft ? U.formatFunsrKpCommand(funsrDraft) : '설정값을 확인해 주세요'
        if ($('funsr-speed-value')) {
            $('funsr-speed-value').setAttribute('aria-invalid', String(!hasDraft))
            $('funsr-speed-value').setCustomValidity(funsrDraftError)
        }
        if ($('funsr-device-confirm')) $('funsr-device-confirm').disabled = !opened || busy || selecting || Boolean(funsrPending)
        if ($('funsr-speed-reported')) $('funsr-speed-reported').textContent = funsrReported === null ? '아직 확인하지 않음' : funsrReported.toFixed(2) + ' (부팅 보고)'
        if (apply) {
            apply.disabled = !supported || !opened || !port?.writable || busy || selecting || !hasDraft || !funsrConfirmed || blocked || Boolean(funsrPending)
            apply.setAttribute('aria-busy', String(Boolean(funsrPending)))
        }
        // Hold unrelated senders only while this one request is being written
        // or awaiting its bounded ACK window, avoiding ambiguous interleaving.
        if ($('serial-loop-send')) $('serial-loop-send').disabled = Boolean(funsrPending)
        if ($('serial-code-run')) $('serial-code-run').disabled = Boolean(funsrPending) && !worker
        let state, text
        if (funsrPending) {
            state = funsrPending.written ? 'waiting' : 'sending'
            text = funsrPending.command + (funsrPending.written ? ' 전송됨 · 저장 응답을 기다립니다. (최대 8초)' : ' 전송 중 · 기기 저장 여부는 아직 확인하지 않았습니다.')
        } else if (!hasDraft) {
            state = 'invalid'; text = funsrDraftError
        } else if (!opened || busy || selecting) {
            state = 'disconnected'; text = 'FUNSR PRO의 포트를 연결한 뒤 설정을 전송해 주세요.'
        } else if (loopActive || worker) {
            state = 'blocked'; text = '반복 전송과 사용자 스크립트를 먼저 중지해 주세요.'
        } else if (sending || pendingWrites > 0) {
            state = 'blocked'; text = '진행 중인 다른 전송이 끝난 뒤 설정을 전송해 주세요.'
        } else if (!funsrConfirmed) {
            state = 'unconfirmed'; text = '선택한 장치가 FUNSR PRO인지 직접 확인하고 체크해 주세요.'
        } else if (funsrOutcome?.epoch === epoch) {
            state = funsrOutcome.state; text = funsrOutcome.text
        } else {
            state = 'ready'; text = '보낼 값을 확인한 뒤 설정 전송을 누르세요. 한 번만 전송합니다.'
        }
        if (statusNode) { statusNode.dataset.state = state; statusNode.textContent = text }
    }

    function changeFunsrDraft(value, normalize = true) {
        try {
            funsrDraft = U.validateFunsrKp(value); funsrLastDraft = funsrDraft; funsrDraftError = ''
            if ($('funsr-speed-range')) {
                $('funsr-speed-range').value = funsrDraft.toFixed(1)
                $('funsr-speed-range').setAttribute('aria-valuetext', funsrDraft.toFixed(1) + ' Kp')
            }
            if (normalize && $('funsr-speed-value')) $('funsr-speed-value').value = funsrDraft.toFixed(1)
        } catch (error) {
            funsrDraft = null; funsrDraftError = errorText(error)
        }
        updateFunsr()
    }

    function resetFunsrSession(reason = '') {
        if (funsrPending && reason) systemLog(funsrPending.command + ' 응답 확인을 중단했습니다. ' + reason + ' 기기 저장 여부는 확인하지 못했습니다.')
        clearTimeout(funsrAckTimer); funsrAckTimer = null
        funsrPending = null; funsrOutcome = null; funsrReported = null; funsrConfirmed = false
        funsrParser.reset()
        if ($('funsr-device-confirm')) $('funsr-device-confirm').checked = false
        updateFunsr()
    }

    function finishFunsr(request, state, text) {
        if (funsrPending !== request || request.epoch !== epoch || request.port !== port || !opened) return
        clearTimeout(funsrAckTimer); funsrAckTimer = null
        funsrPending = null; funsrOutcome = { state, text, epoch }
        // Keep a following, partially received boot line intact. A subsequent
        // request or connection boundary resets the parser before ACK matching.
        systemLog(text); updateConnection()
    }

    function confirmFunsrSaved(request) {
        if (request.written && request.matchingValue && request.saved) {
            finishFunsr(request, 'saved', request.command + ' 저장 응답을 확인했습니다. 기기를 직접 재시작하세요. 부팅 보고값은 별도로 확인합니다.')
        }
    }

    function receiveFunsr(bytes) {
        if (!opened) return
        // Keep each parser batch below its event cap even when a serial driver
        // delivers a very large read containing many short status lines.
        for (let offset = 0; offset < bytes.length; offset += 1024) {
            const events = funsrParser.push(bytes.subarray(offset, offset + 1024))
            for (const event of events) {
                if (event.type === 'boot') {
                    if (funsrReported !== event.value) { funsrReported = event.value; updateFunsr() }
                    continue
                }
                const request = funsrPending
                if (!request || request.epoch !== epoch || request.port !== port || request.phase === 'queued') continue
                if (event.type === 'new-kp') {
                    request.matchingValue = Math.abs(event.value - request.value) < 1e-9
                    request.saved = false
                } else if (event.type === 'saved' && request.matchingValue) {
                    request.saved = true
                    confirmFunsrSaved(request)
                }
            }
        }
    }

    async function applyFunsr() {
        // A disabled button is presentation, not the safety boundary: enforce
        // every guard again for synthetic events and concurrent UI changes.
        if (funsrPending) return
        changeFunsrDraft($('funsr-speed-value')?.value, true)
        if (funsrDraft === null || !opened || !supported || !port?.writable || busy || selecting || !funsrConfirmed || !$('funsr-device-confirm')?.checked || loopActive || worker || sending || pendingWrites > 0) { updateFunsr(); return }
        const request = {
            epoch, port, value: funsrDraft, command: U.formatFunsrKpCommand(funsrDraft),
            phase: 'queued', written: false, matchingValue: false, saved: false,
        }
        funsrPending = request; funsrOutcome = null
        // Old complete lines and old partial prefixes cannot become this
        // request's ACK. Reset once now, and again exactly at write dispatch.
        funsrParser.reset(); updateConnection()
        try {
            await transmit(U.buildFunsrKpPayload(request.value), request)
            if (funsrPending !== request || request.epoch !== epoch || request.port !== port || !opened) return
            request.written = true; request.phase = 'written'
            remember({ content: request.command, hex: false, lineEnding: 'crlf' })
            confirmFunsrSaved(request)
            if (funsrPending !== request) return
            funsrAckTimer = setTimeout(() => {
                finishFunsr(request, 'unconfirmed-save', request.command + ' 전송됨, 저장 응답 미확인. 자동 재전송하지 않습니다. 장치와 수신 로그를 확인해 주세요.')
            }, FUNSR_ACK_TIMEOUT)
            updateFunsr()
        } catch (error) {
            finishFunsr(request, 'error', request.command + ' 전송을 완료하지 못했습니다. 기기 저장 여부는 확인하지 못했습니다. ' + errorText(error))
        }
    }

    async function readSerial(selectedPort, token) {
        while (opened && epoch === token && selectedPort.readable) {
            const localReader = selectedPort.readable.getReader()
            reader = localReader
            try {
                while (opened && epoch === token) {
                    const { value, done } = await localReader.read()
                    if (done) return
                    if (value && opened && epoch === token) receiveData(value)
                }
            } finally {
                localReader.releaseLock()
                if (reader === localReader) reader = null
            }
        }
    }
    async function openSerial(automatic = false) {
        if (busy || selecting || opened || !supported) return
        if (!port) { message('먼저 연결할 포트를 선택해 주세요.'); return }
        if (automatic && (!reconnectArmed || !prefs.autoReconnect)) return
        try { options = readOptions() } catch (error) { message(errorText(error), '연결 설정 확인'); return }
        const selectedPort = port
        busy = true; closeFailed = false; resetFunsrSession()
        status(automatic ? '선택했던 장치에 다시 연결하는 중입니다…' : '포트 연결을 여는 중입니다…')
        try {
            await selectedPort.open(options)
            mayBeOpen = true; opened = true; reconnectArmed = false; manuallyClosed = false; epoch++
            const token = epoch
            resetDecoder(false); saveConfig(); startSession()
            status('연결되었습니다. 전송 버튼을 누르기 전에는 데이터를 보내지 않습니다.')
            systemLog((automatic ? '선택했던 장치에 다시 연결했습니다. ' : '시리얼 연결을 열었습니다. ') + options.baudRate.toLocaleString('ko-KR') + ' baud · ' + options.dataBits + (options.parity === 'even' ? 'E' : options.parity === 'odd' ? 'O' : 'N') + options.stopBits)
            readTask = readSerial(selectedPort, token)
            readTask.then(() => {
                if (opened && epoch === token) {
                    reconnectArmed = prefs.autoReconnect
                    systemLog('수신 스트림이 종료되어 연결을 정리합니다.')
                    void closeSerial(false)
                }
            }, (error) => {
                if (opened && epoch === token) {
                    reconnectArmed = prefs.autoReconnect
                    systemLog('수신 중 오류가 발생하여 연결을 정리합니다. ' + errorText(error))
                    void closeSerial(false)
                }
            })
        } catch (error) {
            opened = false
            systemLog('시리얼 연결을 열지 못했습니다. ' + errorText(error))
            status('연결 실패 · 다른 프로그램의 포트 점유와 장치 설정을 확인해 주세요.')
            if (!automatic) message('포트 연결을 열지 못했습니다. ' + errorText(error), '연결 실패')
        } finally { busy = false; updateConnection() }
    }
    function closeSerial(manual = true) {
        if (manual) { reconnectArmed = false; manuallyClosed = true }
        if (closeTask) return closeTask
        const selectedPort = port, wasOpen = opened || mayBeOpen
        opened = false; epoch++; resetFunsrSession('포트 연결이 종료되었습니다.'); stopLoop(); stopWorker(); busy = true
        status('연결과 데이터 스트림을 정리하는 중입니다…')
        closeTask = (async () => {
            try {
                const cancellations = []
                if (reader) cancellations.push(reader.cancel().catch(() => {}))
                if (activeWriter) cancellations.push(activeWriter.abort().catch(() => {}))
                await Promise.all(cancellations)
                if (readTask) await readTask.catch(() => {})
                await writeTail
                resetDecoder()
                if (selectedPort && mayBeOpen) await selectedPort.close()
                mayBeOpen = false; closeFailed = false
                if (wasOpen) systemLog(manual ? '시리얼 연결을 닫았습니다.' : '장치 연결이 끊어졌습니다.' + (reconnectArmed ? ' 선택했던 장치가 다시 연결되면 재연결을 시도합니다.' : ' 다시 연결하려면 연결하기를 눌러 주세요.'))
                status(manual ? '연결을 닫았습니다. 포트를 다시 열 수 있습니다.' : reconnectArmed ? '선택한 장치의 재연결을 기다리는 중입니다.' : '장치가 분리되었거나 통신이 종료되었습니다.')
            } catch (error) {
                closeFailed = true
                systemLog('포트를 완전히 닫지 못했습니다. ' + errorText(error))
                status('포트 종료를 확인하지 못했습니다. 닫기 재시도를 누르거나 장치 상태를 확인해 주세요.')
            } finally {
                reader = null; readTask = null; activeWriter = null; busy = false; closeTask = null
                finishSession(); updateConnection()
            }
        })()
        return closeTask
    }
    async function selectPort() {
        if (!supported || busy || selecting || opened || mayBeOpen) return
        selecting = true; reconnectArmed = false; manuallyClosed = true; resetFunsrSession(); updateConnection()
        try {
            // Only a direct click can reach requestPort; never auto-select a
            // remembered device or replace one from a global connect event.
            port = await navigator.serial.requestPort()
            closeFailed = false
            status('포트를 선택했습니다. 설정을 확인한 뒤 연결하기를 눌러 주세요.')
        } catch (error) {
            if (!['NotFoundError', 'AbortError'].includes(error?.name)) {
                systemLog('포트를 선택하지 못했습니다. ' + errorText(error))
                message('포트 선택 권한을 확인해 주세요. ' + errorText(error))
            }
        } finally { selecting = false; updateConnection() }
    }
    function eventPort(event) { return event.port || (event.target !== navigator.serial ? event.target : null) }
    if (supported) {
        navigator.serial.addEventListener('disconnect', (event) => {
            if (eventPort(event) !== port) return
            if (opened || mayBeOpen) { reconnectArmed = !manuallyClosed && Boolean(prefs.autoReconnect); void closeSerial(false) }
            else status('선택한 장치가 분리되었습니다.')
        })
        navigator.serial.addEventListener('connect', async (event) => {
            // Same-object equality is intentional. A VID/PID match may refer
            // to a different physical device and must not authorize a switch.
            if (eventPort(event) !== port || !reconnectArmed || !prefs.autoReconnect) return
            if (closeTask) await closeTask
            if (reconnectArmed && prefs.autoReconnect && !closeFailed) await openSerial(true)
        })
    }
    function sendRecord(content, hex, lineEnding) {
        if (typeof content !== 'string' || !content.length) throw new Error('전송할 내용을 입력해 주세요.')
        if (content.length > MAX_SEND) throw new Error('한 번에 전송할 내용은 64 KiB 이하여야 합니다.')
        const bytes = hex ? U.parseHex(content) : U.appendLineEnding(encoder.encode(content), lineEnding)
        if (!bytes.length) throw new Error('전송할 내용을 입력해 주세요.')
        if (bytes.length > MAX_SEND) throw new Error('줄 끝 문자를 포함한 전송 데이터가 64 KiB를 넘습니다.')
        return { content, hex: Boolean(hex), lineEnding, bytes }
    }
    function composerRecord() { return sendRecord($('serial-send-content').value, $('serial-hex-send').checked, $('serial-line-ending').value) }
    function updateByteCount() {
        const input = $('serial-send-content'), label = $('serial-byte-count')
        if (!input || !label) return
        let invalid = false
        try {
            const record = input.value.length ? composerRecord() : null
            label.textContent = U.formatBytes(record?.bytes.length || 0)
            label.title = record?.hex ? 'HEX 원시 바이트 · 줄 끝 문자를 추가하지 않습니다' : 'UTF-8 텍스트 · 선택한 줄 끝 문자 포함'
        } catch (error) { invalid = true; label.textContent = '입력 확인 필요'; label.title = errorText(error) }
        input.classList.toggle('is-invalid', invalid); input.setAttribute('aria-invalid', String(invalid)); updateSendButton()
    }
    function updateSendButton() {
        const button = $('serial-send')
        if (!button) return
        const invalid = $('serial-send-content')?.getAttribute('aria-invalid') === 'true'
        button.disabled = !connected() || busy || selecting || sending || Boolean(funsrPending) || (invalid && !loopActive)
        buttonLabel('serial-send', loopActive ? '반복 전송 중지' : sending ? '전송 중…' : '전송', loopActive ? 'bi-stop' : 'bi-arrow-up-right', loopActive || sending ? '' : 'Ctrl ↵')
        button.title = loopActive ? '진행 중인 반복 전송을 멈춥니다' : 'Ctrl/Cmd + Enter로 전송'
        updateFunsr()
    }
    function remember(record) {
        history = normalizedHistory([{ content: record.content, hex: record.hex, lineEnding: record.lineEnding, time: new Date().toISOString() }, ...history])
        if (!historyBlocked) writeStorage(HISTORY_KEY, JSON.stringify(history))
        historyCursor = -1; historyDraft = null; renderHistory()
    }
    function transmit(data, funsrRequest = null) {
        if (!(data instanceof Uint8Array) || !data.length || data.length > MAX_SEND) return Promise.reject(new Error('전송 데이터는 1~65,536 바이트여야 합니다.'))
        if (!connected() || busy) return Promise.reject(new Error('포트를 연결한 뒤 전송해 주세요.'))
        if (funsrPending && funsrRequest !== funsrPending) return Promise.reject(new Error('FUNSR PRO 저장 응답을 확인하는 동안 다른 전송은 잠시 기다려 주세요.'))
        if (pendingWrites >= 64) return Promise.reject(new Error('대기 중인 전송이 너무 많습니다. 전송 주기를 늘려 주세요.'))
        const payload = data.slice(), token = epoch, selectedPort = port
        pendingWrites++; updateFunsr()
        const task = writeTail.then(async () => {
            if (epoch !== token || !connected() || busy) throw new Error('연결 상태가 바뀌어 대기 중인 전송을 취소했습니다.')
            if (funsrPending && funsrRequest !== funsrPending) throw new Error('FUNSR PRO 설정 전송과 다른 전송을 동시에 실행할 수 없습니다.')
            if (funsrRequest && (funsrPending !== funsrRequest || funsrRequest.epoch !== epoch || funsrRequest.port !== port || !funsrConfirmed || !$('funsr-device-confirm')?.checked || loopActive || worker)) throw new Error('FUNSR PRO 연결 확인 또는 실행 상태가 바뀌어 전송을 취소했습니다.')
            if (!selectedPort?.writable) throw new Error('포트 전송 스트림을 사용할 수 없습니다. 다시 연결해 주세요.')
            const writer = selectedPort.writable.getWriter()
            activeWriter = writer
            try {
                if (funsrRequest) { funsrParser.reset(); funsrRequest.phase = 'writing' }
                await writer.write(payload); txCount += payload.length; addBytes(payload, 'tx')
            }
            finally { writer.releaseLock(); if (activeWriter === writer) activeWriter = null }
        })
        writeTail = task.catch(() => {}).finally(() => { pendingWrites--; updateCounters(); updateFunsr() })
        return task
    }
    function confirmCommand(record) {
        const risky = !record.hex && /(?:^|[\r\n])\s*(?:AT\+(?:RESTORE|RST|GSLP|UART_DEF|SYSFLASH|SYSMFG|SAVETRANSLINK)(?:=|\s*$)|AT\+(?:CIUPDATE|CIPUPDATE))/i.test(record.content)
        return !risky || window.confirm('이 명령은 장치를 재시작하거나 설정·플래시 데이터를 변경할 수 있습니다. 장치 문서를 확인한 명령만 전송해 주세요. 계속할까요?')
    }
    async function sendComposer() {
        if (loopActive) { stopLoop(); return }
        if (sending) return
        try {
            const record = composerRecord()
            if (!confirmCommand(record)) return
            sending = true; updateSendButton()
            await transmit(record.bytes); remember(record)
            if (prefs.loopSend && connected()) { loopActive = true; loopRecord = record; loopEpoch++; scheduleLoop(loopEpoch) }
        } catch (error) { stopLoop(); systemLog('전송하지 못했습니다. ' + errorText(error)) }
        finally { sending = false; updateSendButton() }
    }
    function scheduleLoop(token) {
        clearTimeout(loopTimer)
        loopTimer = setTimeout(async () => {
            if (!loopActive || token !== loopEpoch || !loopRecord || !connected()) return
            try { await transmit(loopRecord.bytes); if (loopActive && token === loopEpoch && connected()) scheduleLoop(token) }
            catch (error) { stopLoop(); systemLog('오류로 반복 전송을 중지했습니다. ' + errorText(error)) }
        }, Math.max(100, prefs.loopSendTime))
        updateSendButton()
    }
    function stopLoop() {
        clearTimeout(loopTimer); loopTimer = null; loopActive = false; loopRecord = null; loopEpoch++; prefs.loopSend = false
        if ($('serial-loop-send')) $('serial-loop-send').checked = false
        updateSendButton()
    }
    function clearLogs(ask = true) {
        if (ask && entries.length && !window.confirm('보관 중인 로그와 송수신 바이트 수를 지울까요? 필요하다면 먼저 로그를 저장해 주세요.')) return
        flushReceive(); entries = []; logBytes = 0; rxCount = 0; txCount = 0; fullRender = true
        // Explicit clearing also clears the frozen display while paused.
        logs.replaceChildren(); visibleCount = 0; renderedId = 0
        if ($('serial-empty-state')) $('serial-empty-state').hidden = false
        updateCounters(); if (!paused) renderLogs()
    }
    function renderHistory() {
        const select = $('serial-history')
        if (!select) return
        select.replaceChildren()
        const placeholder = document.createElement('option')
        placeholder.value = ''; placeholder.textContent = history.length ? '최근 전송 기록 (' + history.length + '/30)' : '최근 전송 기록 없음'; select.appendChild(placeholder)
        const endings = { none: '줄 끝 없음', lf: 'LF', cr: 'CR', crlf: 'CRLF' }
        history.forEach((record, index) => {
            const option = document.createElement('option'); option.value = String(index)
            option.textContent = (record.hex ? 'HEX' : '텍스트') + ' · ' + record.content.replace(/\s+/g, ' ').slice(0, 64) + ' · ' + (record.hex ? '원시 바이트' : endings[record.lineEnding])
            select.appendChild(option)
        })
        select.value = ''
        if ($('serial-history-clear')) $('serial-history-clear').disabled = !history.length && !historyBlocked
    }
    function fillComposer(record, focus = true) {
        stopLoop(); $('serial-send-content').value = record.content; $('serial-hex-send').checked = Boolean(record.hex)
        $('serial-line-ending').value = record.lineEnding || prefs.lineEnding
        prefs.sendContent = record.content; prefs.hexSend = Boolean(record.hex); prefs.lineEnding = $('serial-line-ending').value
        saveConfig(); updateByteCount(); if (focus) $('serial-send-content').focus()
    }
    function group() { return groups[prefs.quickSendIndex] || groups[0] }
    function quickButton(text, className, title) {
        const button = document.createElement('button')
        button.type = 'button'; button.className = 'btn btn-sm btn-outline-secondary ' + className; button.textContent = text
        button.title = title; button.setAttribute('aria-label', title)
        return button
    }
    function renderQuick() {
        const select = $('serial-quick-send'), container = $('serial-quick-send-content')
        if (!select || !container) return
        select.replaceChildren()
        groups.forEach((item, index) => {
            const option = document.createElement('option'); option.value = String(index); option.textContent = item.name; select.appendChild(option)
        })
        prefs.quickSendIndex = Math.min(Math.max(0, prefs.quickSendIndex), groups.length - 1)
        select.value = String(prefs.quickSendIndex); container.replaceChildren()
        group().list.forEach((item, index) => {
            const row = document.createElement('div'); row.className = 'quick-item'; row.dataset.index = String(index)
            const remove = quickButton('×', 'quick-remove', item.name + ' 명령 삭제')
            const input = document.createElement('input'); input.type = 'text'; input.className = 'form-control form-control-sm'; input.value = item.content; input.maxLength = MAX_SEND
            input.placeholder = '명령 내용 · 더블클릭으로 이름 변경'; input.title = '내용을 편집합니다. 이름은 더블클릭으로 바꿀 수 있습니다.'; input.setAttribute('aria-label', item.name + ' 명령 내용')
            const load = quickButton('담기', 'quick-load', item.name + ' 명령을 입력창에 담기 (전송하지 않음)')
            const send = quickButton(item.name, 'quick-send', item.name + ' 명령 전송'); send.disabled = !connected() || busy || Boolean(funsrPending)
            const label = document.createElement('label'); label.className = 'quick-label'
            const hex = document.createElement('input'); hex.type = 'checkbox'; hex.className = 'form-check-input'; hex.checked = item.hex; hex.setAttribute('aria-label', item.name + ' 명령을 HEX로 전송')
            const labelText = document.createElement('span'); labelText.textContent = 'HEX'; label.append(hex, labelText)
            row.append(remove, input, load, send, label); container.appendChild(row)
        })
        if ($('serial-quick-send-remove-group')) $('serial-quick-send-remove-group').disabled = groups.length <= 1
    }
    function changeName(callback, previous = '') {
        if (!nameModal) {
            const name = window.prompt('이름을 입력해 주세요. (최대 120자)', previous)
            if (name !== null && name.trim() && name.trim().length <= 120) callback(name.trim())
            return
        }
        const input = $('model-new-name'); input.value = previous; input.maxLength = 120; input.setCustomValidity('')
        const save = () => {
            const name = input.value.trim()
            if (!name || name.length > 120) { input.setCustomValidity('이름은 1~120자로 입력해 주세요.'); input.reportValidity(); return }
            callback(name); nameModal.hide()
        }
        $('model-save-name').onclick = save
        input.oninput = () => input.setCustomValidity('')
        input.onkeydown = (event) => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); save() } }
        nameModal.show()
    }
    function saveQuick() {
        try { groups = U.validateQuickSendList(groups); validGroups = structuredClone(groups); saveConfig() }
        catch (error) { groups = structuredClone(validGroups); renderQuick(); message(errorText(error), '빠른 명령 확인') }
    }
    function fileName(name) { return String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 100) || '시리얼' }
    function download(blob, filename) {
        const url = URL.createObjectURL(blob), link = document.createElement('a')
        link.href = url; link.download = filename; link.hidden = true; document.body.appendChild(link); link.click(); link.remove()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
    }
    function downloadJSON(value, filename) {
        const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json;charset=utf-8' })
        if (blob.size > MAX_FILE) throw new Error('백업 파일이 2 MiB를 넘습니다. 전송 기록이나 명령을 나누어 보관해 주세요.')
        download(blob, filename)
    }
    async function readFile(input, limit = MAX_FILE) {
        const file = input.files?.[0]; input.value = ''
        if (!file) return null
        if (file.size > limit) throw new Error('파일 크기는 ' + U.formatBytes(limit) + ' 이하여야 합니다.')
        return file.text()
    }
    function filteredLogText() {
        const lines = []
        for (const entry of entries) {
            if (!matches(entry)) continue
            const prefix = (prefs.showTime ? U.formatTimestamp(entry.date) + ' ' : '') + '[' + (entry.direction === 'system' ? '안내' : entry.direction.toUpperCase()) + '] '
            if (entry.direction === 'system') lines.push(prefix + visibleText(entry.text))
            else {
                if (prefs.logType.includes('hex')) lines.push(prefix + (prefs.logType === 'hex&text' ? 'HEX ' : '') + U.bytesToHex(entry.bytes))
                if (prefs.logType.includes('text') || prefs.logType === 'ansi') lines.push(prefix + (prefs.logType === 'hex&text' ? 'TXT ' : '') + visibleText(stripANSI(entry.text)))
            }
        }
        return lines.join('\n')
    }
    async function copyLogs() {
        const text = filteredLogText()
        if (!text) { message('현재 필터에 맞는 로그가 없습니다.'); return }
        try {
            if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text)
            else {
                const textarea = document.createElement('textarea'); textarea.value = text; textarea.style.position = 'fixed'; textarea.style.left = '-9999px'; document.body.appendChild(textarea)
                try { textarea.select(); if (!document.execCommand('copy')) throw new Error('브라우저에서 복사를 허용하지 않았습니다.') }
                finally { textarea.remove() }
            }
            message('현재 필터에 맞는 보관 로그를 복사했습니다.')
        } catch (error) { message('로그를 복사하지 못했습니다. 로그 저장을 이용해 주세요. ' + errorText(error)) }
    }
    function currentCode() { return editor ? editor.getValue() : $('serial-code-content').value }
    function setupEditor() {
        const textarea = $('serial-code-content')
        if (!textarea) return
        textarea.value = code
        const persist = () => {
            clearTimeout(codeSaveTimer)
            codeSaveTimer = setTimeout(() => { const value = currentCode(); if (value.length <= MAX_CODE) { code = value; saveConfig() } }, 300)
        }
        if (window.CodeMirror?.fromTextArea) {
            editor = CodeMirror.fromTextArea(textarea, { lineNumbers: true, indentUnit: 4, styleActiveLine: true, matchBrackets: true, mode: 'javascript', theme: 'idea', lineWrapping: true })
            editor.on('change', persist); editor.getWrapperElement().setAttribute('aria-label', '시리얼 스크립트 편집기')
        } else textarea.addEventListener('input', persist)
        on('nav-code-tab', 'shown.bs.tab', () => editor?.refresh())
    }
    function replaceCode(value) { code = value; if (editor) editor.setValue(value); else if ($('serial-code-content')) $('serial-code-content').value = value }
    function stopWorker() {
        if (worker) worker.terminate()
        worker = null
        if (workerURL) URL.revokeObjectURL(workerURL)
        workerURL = null
        if (editor) { editor.setOption('readOnly', false); editor.getWrapperElement().classList.remove('CodeMirror-readonly') }
        else if ($('serial-code-content')) $('serial-code-content').readOnly = false
        if ($('serial-code-run')) { buttonLabel('serial-code-run', '실행', 'bi-play'); $('serial-code-run').setAttribute('aria-pressed', 'false') }
        if ($('serial-code-load')) $('serial-code-load').disabled = false
        updateFunsr()
    }
    function workerData(value) {
        if (value instanceof ArrayBuffer) value = new Uint8Array(value)
        if (!(value instanceof Uint8Array) && !Array.isArray(value)) throw new Error('uart_send의 data에는 바이트 배열을 넣어 주세요.')
        if (!value.length || value.length > MAX_SEND) throw new Error('스크립트 전송 데이터는 1~65,536 바이트여야 합니다.')
        if (Array.isArray(value)) for (let index = 0; index < value.length; index++) {
            if (!Number.isInteger(value[index]) || value[index] < 0 || value[index] > 255) throw new Error('바이트 배열에는 빠짐없이 0~255 정수만 사용할 수 있습니다.')
        }
        return Uint8Array.from(value)
    }
    async function workerMessage(source, event) {
        if (source !== worker) return
        try {
            if (Date.now() - workerWindow >= 1000) { workerWindow = Date.now(); workerMessages = 0; workerBytes = 0 }
            workerMessages++
            const data = event.data
            if (!data || typeof data !== 'object' || typeof data.type !== 'string') throw new Error('스크립트 메시지 형식이 올바르지 않습니다.')
            workerBytes += typeof data.data === 'string' ? data.data.length * 2 : Number(data.data?.byteLength || data.data?.length || 0)
            if (workerMessages > 200 || workerBytes > 1024 * 1024) throw new Error('스크립트 메시지가 너무 많습니다. 전송 간격을 늘려 주세요.')
            if (data.type === 'log') systemLog('스크립트 · ' + String(typeof data.data === 'string' ? data.data : JSON.stringify(data.data)).slice(0, MAX_ENTRY))
            else if (data.type === 'uart_send') await transmit(workerData(data.data))
            else if (data.type === 'uart_send_hex' || data.type === 'uart_send_txt') await transmit(sendRecord(data.data, data.type === 'uart_send_hex', prefs.lineEnding).bytes)
            else throw new Error('지원하지 않는 스크립트 메시지입니다: ' + data.type.slice(0, 80))
        } catch (error) {
            if (source !== worker) return
            stopWorker(); stopLoop(); systemLog('스크립트를 중지했습니다. ' + errorText(error))
        }
    }
    function runWorker() {
        if (worker) { stopWorker(); systemLog('스크립트를 중지했습니다.'); return }
        if (funsrPending) { message('FUNSR PRO 저장 응답 확인이 끝난 뒤 스크립트를 실행해 주세요.'); return }
        const value = currentCode()
        if (!value.trim()) { message('실행할 스크립트를 입력해 주세요.'); return }
        if (value.length > MAX_CODE) { message('스크립트는 262,144자 이하여야 합니다.'); return }
        if (!window.Worker) { message('이 브라우저는 스크립트 실행을 지원하지 않습니다.'); return }
        if (!window.confirm('스크립트는 연결된 장치에 데이터를 전송하고 네트워크 요청을 실행할 수 있습니다. 신뢰할 수 있는 코드를 확인한 뒤에만 실행해 주세요. 실행할까요?')) return
        try {
            code = value; saveConfig()
            workerURL = URL.createObjectURL(new Blob([value], { type: 'text/javascript' })); worker = new Worker(workerURL)
            const source = worker
            workerWindow = Date.now(); workerMessages = 0; workerBytes = 0
            source.onmessage = (event) => { void workerMessage(source, event) }
            source.onerror = (event) => {
                event.preventDefault()
                if (source !== worker) return
                stopWorker(); stopLoop(); systemLog('스크립트 실행 오류' + (event.lineno ? ' (' + event.lineno + '행)' : '') + ': ' + String(event.message || '코드를 확인해 주세요.').slice(0, 500))
            }
            source.onmessageerror = () => { if (source === worker) { stopWorker(); systemLog('스크립트 메시지를 해석하지 못해 실행을 중지했습니다.') } }
            if (editor) { editor.setOption('readOnly', 'nocursor'); editor.getWrapperElement().classList.add('CodeMirror-readonly') }
            else $('serial-code-content').readOnly = true
            buttonLabel('serial-code-run', '중지', 'bi-stop'); $('serial-code-run').setAttribute('aria-pressed', 'true')
            if ($('serial-code-load')) $('serial-code-load').disabled = true
            systemLog('스크립트를 실행했습니다. 탭이 숨겨지면 브라우저가 타이머를 늦출 수 있습니다.')
            updateFunsr()
        } catch (error) { stopWorker(); systemLog('스크립트를 실행하지 못했습니다. ' + errorText(error)) }
    }
    function applyImport(value) {
        stopLoop(); stopWorker(); options = value.serialOptions; prefs = value.toolOptions; prefs.loopSend = false; groups = value.quickSendList; validGroups = structuredClone(groups); replaceCode(value.code)
        if (value.history) { history = normalizedHistory(value.history); historyBlocked = false; writeStorage(HISTORY_KEY, JSON.stringify(history)) }
        configBlocked = false; reconnectArmed = false; resetFunsrSession()
        applyHardware(); applyPreferences(); resetDecoder(); renderQuick(); renderHistory(); trimLogs(); saveConfig()
        writeStorage(THEME_KEY, document.documentElement.dataset.theme); renderSoon(true); updateConnection()
    }

    // Loading preferences never opens a port, starts a worker or starts a sender.
    loadConfig(); validGroups = structuredClone(groups); applyHardware(); applyPreferences(); setupEditor(); renderQuick(); renderHistory(); resetFunsrSession(); changeFunsrDraft(1.2); updateConnection()
    ready = true
    for (const text of startupWarnings) systemLog(text)
    renderSoon(true)
    let counterTimer = setInterval(updateCounters, 1000)

    on('serial-select-port', 'click', () => { void selectPort() })
    on('serial-open-or-close', 'click', () => {
        if (busy) return
        if (opened || mayBeOpen || closeFailed) void closeSerial(true)
        else void openSerial(false)
    })
    on('funsr-speed-range', 'input', (event) => changeFunsrDraft(event.target.value))
    on('funsr-speed-range', 'change', (event) => changeFunsrDraft(event.target.value))
    on('funsr-speed-value', 'input', (event) => changeFunsrDraft(event.target.value, false))
    on('funsr-speed-value', 'change', (event) => changeFunsrDraft(event.target.value))
    on('funsr-speed-decrease', 'click', () => changeFunsrDraft(Math.max(0.5, (Math.round(funsrLastDraft * 10) - 1) / 10)))
    on('funsr-speed-increase', 'click', () => changeFunsrDraft(Math.min(5, (Math.round(funsrLastDraft * 10) + 1) / 10)))
    on('funsr-speed-minimum', 'click', () => changeFunsrDraft(0.5))
    on('funsr-speed-default', 'click', () => changeFunsrDraft(1.2))
    on('funsr-speed-maximum', 'click', () => changeFunsrDraft(5))
    on('funsr-device-confirm', 'change', (event) => {
        funsrConfirmed = Boolean(event.target.checked && opened && !busy && !selecting)
        event.target.checked = funsrConfirmed; updateFunsr()
    })
    on('funsr-speed-apply', 'click', () => { void applyFunsr() })
    for (const id of ['funsr-speed-range', 'funsr-speed-value']) on(id, 'keydown', (event) => {
        if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation() }
    })
    on('serial-send', 'click', () => { void sendComposer() })
    on('serial-clear', 'click', () => clearLogs())
    on('serial-copy', 'click', () => { void copyLogs() })
    on('serial-save', 'click', () => {
        const text = filteredLogText()
        if (!text) { message('현재 필터에 맞는 로그가 없습니다.'); return }
        download(new Blob(['\uFEFF', text], { type: 'text/plain;charset=utf-8' }), '시리얼-로그-' + new Date().toISOString().replace(/[:.]/g, '-') + '.txt')
    })
    on('serial-theme', 'click', () => { setPref('theme', document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); applyTheme(); writeStorage(THEME_KEY, prefs.theme) })
    on('serial-auto-scroll', 'click', () => { setPref('autoScroll', !prefs.autoScroll); updateLogButtons(); renderSoon() })
    on('serial-pause', 'click', () => { paused = !paused; updateLogButtons(); updateConnection(); if (!paused) renderSoon(true) })
    on('serial-search', 'input', (event) => { search = event.target.value.slice(0, 256).toLocaleLowerCase('ko-KR'); renderSoon(true) })
    on('serial-direction', 'change', (event) => { direction = ['all', 'rx', 'tx', 'system'].includes(event.target.value) ? event.target.value : 'all'; renderSoon(true) })
    on('serial-show-time', 'change', (event) => { setPref('showTime', event.target.checked); renderSoon(true) })
    on('serial-wrap', 'change', (event) => { setPref('wrap', event.target.checked); renderSoon(true) })
    on('serial-log-type', 'change', (event) => { setPref('logType', event.target.value); renderSoon(true) })
    on('serial-log-limit', 'change', (event) => { setPref('logLimit', Number(event.target.value)); trimLogs(); updateCounters(); renderSoon(true) })
    on('serial-timer-out', 'change', (event) => { flushReceive(); setPref('timeOut', Number(event.target.value)); event.target.value = prefs.timeOut })
    on('serial-auto-reconnect', 'change', (event) => { setPref('autoReconnect', event.target.checked); if (!prefs.autoReconnect) reconnectArmed = false })
    on('serial-encoding', 'change', (event) => {
        flushReceive(); const tail = decoder.flush(); if (tail) addEntry('rx', new Uint8Array(), tail)
        setPref('encoding', event.target.value); resetDecoder(false)
        systemLog('이후 수신 문자의 인코딩을 ' + prefs.encoding.toUpperCase() + '(으)로 변경했습니다. 텍스트 전송은 UTF-8입니다.')
    })
    for (const id of Object.values(hardwareFields)) on(id, 'change', () => {
        if (opened || busy || mayBeOpen) return
        try { options = readOptions(); setPref('preset', 'custom'); if ($('serial-preset')) $('serial-preset').value = 'custom'; saveConfig() }
        catch (error) { message(errorText(error), '연결 설정 확인') }
    })
    on('serial-preset', 'change', (event) => {
        if (connected() || busy || mayBeOpen) return
        const presets = {
            arduino: { baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none', lineEnding: 'lf' },
            esp32: { baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none', lineEnding: 'crlf' },
            modbus: { baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'even', lineEnding: 'none' },
        }
        const preset = presets[event.target.value]
        if (preset) {
            options = U.validateSerialOptions({ ...options, baudRate: preset.baudRate, dataBits: preset.dataBits, stopBits: preset.stopBits, parity: preset.parity, flowControl: 'none' })
            prefs.lineEnding = preset.lineEnding; $('serial-line-ending').value = preset.lineEnding; applyHardware(); updateByteCount()
        }
        setPref('preset', event.target.value); saveConfig()
    })
    on('serial-send-content', 'input', (event) => {
        if (loopActive) stopLoop()
        historyCursor = -1; historyDraft = null; setPref('sendContent', event.target.value); updateByteCount()
    })
    on('serial-send-content', 'compositionstart', () => { composing = true })
    on('serial-send-content', 'compositionend', () => { composing = false; updateByteCount() })
    on('serial-hex-send', 'change', (event) => { if (loopActive) stopLoop(); setPref('hexSend', event.target.checked); updateByteCount() })
    on('serial-line-ending', 'change', (event) => { if (loopActive) stopLoop(); setPref('lineEnding', event.target.value); updateByteCount() })
    on('serial-loop-send', 'change', (event) => { if (!event.target.checked) stopLoop(); else setPref('loopSend', true) })
    on('serial-loop-send-time', 'change', (event) => { if (loopActive) stopLoop(); setPref('loopSendTime', Number(event.target.value)); event.target.value = prefs.loopSendTime })
    on('serial-history', 'change', (event) => { if (event.target.value !== '' && history[Number(event.target.value)]) fillComposer(history[Number(event.target.value)]) })
    on('serial-history-clear', 'click', () => {
        if (!window.confirm('이 페이지에 저장된 전송 기록을 모두 지울까요? 빠른 명령과 로그는 유지됩니다.')) return
        history = []; historyCursor = -1; historyDraft = null; historyBlocked = false; writeStorage(HISTORY_KEY, '[]'); renderHistory()
    })
    document.addEventListener('keydown', (event) => {
        if (event.isComposing || composing || event.keyCode === 229 || event.defaultPrevented || document.querySelector('.modal.show')) return
        const modifier = event.ctrlKey || event.metaKey
        if (modifier && event.key === 'Enter' && event.target === $('serial-send-content')) { event.preventDefault(); void sendComposer() }
        else if (modifier && event.key.toLowerCase() === 'k') { event.preventDefault(); $('serial-search')?.focus() }
        else if (modifier && event.key.toLowerCase() === 'l' && !event.target.closest?.('.CodeMirror')) { event.preventDefault(); clearLogs() }
        else if (event.altKey && event.target === $('serial-send-content') && ['ArrowUp', 'ArrowDown'].includes(event.key) && history.length) {
            event.preventDefault()
            if (historyCursor === -1) historyDraft = { content: $('serial-send-content').value, hex: $('serial-hex-send').checked, lineEnding: $('serial-line-ending').value }
            historyCursor = Math.min(history.length - 1, Math.max(-1, historyCursor + (event.key === 'ArrowUp' ? 1 : -1)))
            if (historyCursor === -1 && historyDraft) fillComposer(historyDraft)
            else if (historyCursor >= 0) fillComposer(history[historyCursor])
        }
    })
    on('serial-quick-send', 'change', (event) => { setPref('quickSendIndex', Number(event.target.value)); renderQuick() })
    on('serial-quick-send-content', 'click', async (event) => {
        const button = event.target.closest('button'), row = button?.closest('.quick-item')
        if (!row) return
        const index = Number(row.dataset.index), item = group().list[index]
        if (!item) return
        if (button.classList.contains('quick-remove')) {
            if (!window.confirm('“' + item.name + '” 명령을 삭제할까요?')) return
            group().list.splice(index, 1); saveQuick(); renderQuick()
        } else if (button.classList.contains('quick-load')) fillComposer({ ...item, lineEnding: prefs.lineEnding })
        else if (button.classList.contains('quick-send')) {
            try { const record = sendRecord(item.content, item.hex, prefs.lineEnding); if (!confirmCommand(record)) return; await transmit(record.bytes); remember(record) }
            catch (error) { stopLoop(); systemLog('빠른 명령을 전송하지 못했습니다. ' + errorText(error)) }
        }
    })
    on('serial-quick-send-content', 'dblclick', (event) => {
        if (event.target.tagName !== 'INPUT' || event.target.type !== 'text') return
        const selectedGroup = group(), index = Number(event.target.closest('.quick-item').dataset.index)
        changeName((name) => { selectedGroup.list[index].name = name; saveQuick(); renderQuick() }, selectedGroup.list[index].name)
    })
    on('serial-quick-send-content', 'change', (event) => {
        if (event.target.tagName !== 'INPUT') return
        const item = group().list[Number(event.target.closest('.quick-item').dataset.index)]
        if (!item) return
        if (event.target.type === 'text') item.content = event.target.value
        else if (event.target.type === 'checkbox') item.hex = event.target.checked
        saveQuick()
    })
    on('serial-quick-send-add', 'click', () => {
        if (group().list.length >= 200 || groups.reduce((sum, item) => sum + item.list.length, 0) >= 1000) { message('그룹당 200개, 전체 1,000개까지 빠른 명령을 보관할 수 있습니다.'); return }
        group().list.push({ name: '새 명령', content: '', hex: false }); saveQuick(); renderQuick()
        $('serial-quick-send-content').lastElementChild?.querySelector('input[type=text]')?.focus()
    })
    on('serial-quick-send-add-group', 'click', () => {
        if (groups.length >= 50) { message('빠른 명령 그룹은 최대 50개까지 만들 수 있습니다.'); return }
        changeName((name) => { groups.push({ name, list: [] }); prefs.quickSendIndex = groups.length - 1; saveQuick(); renderQuick() })
    })
    on('serial-quick-send-rename-group', 'click', () => { const selectedGroup = group(); changeName((name) => { selectedGroup.name = name; saveQuick(); renderQuick() }, selectedGroup.name) })
    on('serial-quick-send-remove-group', 'click', () => {
        if (groups.length <= 1 || !window.confirm('“' + group().name + '” 그룹과 안의 명령을 삭제할까요?')) return
        groups.splice(prefs.quickSendIndex, 1); prefs.quickSendIndex = 0; saveQuick(); renderQuick()
    })
    on('serial-quick-send-export', 'click', () => {
        try { downloadJSON(group().list, fileName(group().name) + '.json') }
        catch (error) { message('빠른 명령을 내보내지 못했습니다. ' + errorText(error)) }
    })
    on('serial-quick-send-import-btn', 'click', () => $('serial-quick-send-import').click())
    on('serial-quick-send-import', 'change', async (event) => {
        try {
            const text = await readFile(event.target)
            if (text === null) return
            const value = JSON.parse(text)
            if (!Array.isArray(value)) throw new Error('빠른 명령 JSON에는 명령 또는 그룹 배열이 있어야 합니다.')
            if (value.length > 1000) throw new Error('빠른 명령은 전체 1,000개를 넘을 수 없습니다.')
            if (value.length && value.every((item) => item && Array.isArray(item.list))) groups = U.validateQuickSendList([...groups, ...value])
            else { const candidate = structuredClone(groups); candidate[prefs.quickSendIndex].list.push(...value); groups = U.validateQuickSendList(candidate) }
            saveQuick(); renderQuick(); message('빠른 명령을 추가했습니다. 명령을 선택하거나 가져와도 자동 전송하지 않습니다.')
        } catch (error) { message('빠른 명령 가져오기에 실패했습니다. 기존 명령은 유지됩니다. ' + errorText(error)) }
    })
    on('serial-export', 'click', () => {
        try {
            if (!opened) options = readOptions()
            code = currentCode(); const value = envelope(true); U.parseImportedConfig(value)
            downloadJSON(value, 'web-serial-debug-kr-config.json')
        } catch (error) { message('설정을 내보내지 못했습니다. ' + errorText(error)) }
    })
    on('serial-import', 'click', () => {
        if (connected() || mayBeOpen || busy) { message('포트 연결을 해제한 뒤 설정을 가져와 주세요.'); return }
        $('serial-import-file').click()
    })
    on('serial-import-file', 'change', async (event) => {
        try {
            const text = await readFile(event.target)
            if (text === null) return
            if (connected() || mayBeOpen || busy) throw new Error('먼저 포트 연결을 해제해 주세요.')
            const value = U.parseImportedConfig(JSON.parse(text))
            if (!window.confirm('현재 연결 설정·빠른 명령·스크립트를 가져온 설정으로 바꿀까요?' + (value.history ? ' 전송 기록도 교체됩니다.' : '') + ' 가져온 스크립트는 실행하지 않습니다.')) return
            applyImport(value); message('설정을 가져왔습니다. 포트 연결·전송·스크립트는 직접 실행할 때만 시작합니다.')
        } catch (error) { message('설정 가져오기에 실패했습니다. 기존 설정은 유지됩니다. ' + errorText(error)) }
    })
    on('serial-reset', 'click', () => {
        if (connected() || mayBeOpen || busy) { message('포트 연결을 해제한 뒤 초기화해 주세요.'); return }
        if (!window.confirm('이 페이지의 연결·도구 설정, 빠른 명령, 스크립트, 전송 기록을 초기화할까요? 현재 로그와 이전 버전의 원본 저장 데이터는 유지됩니다.')) return
        historyBlocked = false
        applyImport({ serialOptions: U.validateSerialOptions({}), toolOptions: U.normalizeToolOptions({}), quickSendList: structuredClone(defaultQuick), code: defaultCode, history: [] })
        message('기본 설정으로 초기화했습니다. 보관 중인 로그는 유지했습니다.')
    })
    on('serial-code-run', 'click', runWorker)
    on('serial-code-load', 'click', () => $('serial-code-select').click())
    on('serial-code-select', 'change', async (event) => {
        try {
            const value = await readFile(event.target)
            if (value === null) return
            if (value.length > MAX_CODE) throw new Error('스크립트는 262,144자 이하여야 합니다.')
            if (currentCode().trim() && !window.confirm('현재 편집 중인 스크립트를 파일 내용으로 바꿀까요? 코드는 자동 실행하지 않습니다.')) return
            stopWorker(); replaceCode(value); saveConfig()
        } catch (error) { message('스크립트 파일을 읽지 못했습니다. ' + errorText(error)) }
    })
    document.querySelectorAll('.toggle-button').forEach((button) => {
        button.addEventListener('click', () => {
            const panel = button.closest('.sidebar')?.querySelector('.collapse')
            if (!panel) return
            panel.classList.toggle('show'); button.setAttribute('aria-expanded', String(panel.classList.contains('show')))
            button.querySelector('i')?.classList.toggle('bi-chevron-compact-right'); button.querySelector('i')?.classList.toggle('bi-chevron-compact-left')
            requestAnimationFrame(() => editor?.refresh())
        })
    })
    on('model-change-name', 'shown.bs.modal', () => { $('model-new-name').focus(); $('model-new-name').select() })
    $('model-change-name')?.querySelector('form')?.addEventListener('submit', (event) => event.preventDefault())
    window.addEventListener('pagehide', () => {
        resetFunsrSession('페이지가 닫히거나 이동했습니다.')
        stopLoop(); stopWorker(); clearInterval(counterTimer)
        clearTimeout(rxTimer)
        if (opened || mayBeOpen) void closeSerial(true)
    })
    window.addEventListener('pageshow', (event) => {
        if (event.persisted) { clearInterval(counterTimer); counterTimer = setInterval(updateCounters, 1000); updateConnection(); renderSoon(true) }
    })
})()
