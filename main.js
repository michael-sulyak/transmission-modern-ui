(() => {
    'use strict';

    const RPC_URL = '../rpc';
    const DEFAULT_REFRESH_SECONDS = 5;
    const TORRENT_FIELDS = [
        'id', 'name', 'status', 'error', 'error_string', 'eta', 'is_finished',
        'is_stalled', 'labels', 'left_until_done', 'metadata_percent_complete',
        'peers_connected', 'peers_getting_from_us', 'peers_sending_to_us',
        'percent_done', 'queue_position', 'rate_download', 'rate_upload',
        'recheck_progress', 'seed_ratio_mode', 'seed_ratio_limit', 'size_when_done',
        'total_size', 'trackers', 'download_dir', 'uploaded_ever', 'upload_ratio',
        'webseeds_sending_to_us', 'added_date', 'file_count', 'is_private',
        'primary_mime_type', 'activity_date', 'bandwidth_priority'
    ];
    const EXTRA_FIELDS = [
        'comment', 'creator', 'date_created', 'files', 'file_stats', 'hash_string',
        'magnet_link', 'piece_count', 'piece_size', 'activity_date', 'corrupt_ever',
        'desired_available', 'downloaded_ever', 'have_unchecked', 'have_valid',
        'peers', 'start_date', 'tracker_stats', 'webseeds_ex'
    ];
    const STATUS = Object.freeze({
        STOPPED: 0,
        CHECK_WAIT: 1,
        CHECK: 2,
        DOWNLOAD_WAIT: 3,
        DOWNLOAD: 4,
        SEED_WAIT: 5,
        SEED: 6
    });
    const ICONS = Object.freeze({
        play: '<svg><use href="#i-play"/></svg>', pause: '<svg><use href="#i-pause"/></svg>',
        trash: '<svg><use href="#i-trash"/></svg>', info: '<svg><use href="#i-info"/></svg>',
        check: '<svg><use href="#i-check"/></svg>', edit: '<svg><use href="#i-edit"/></svg>',
        folder: '<svg><use href="#i-folder"/></svg>', tag: '<svg><use href="#i-tag"/></svg>',
        more: '<svg><use href="#i-more"/></svg>', add: '<svg><use href="#i-add"/></svg>',
        activity: '<svg><use href="#i-activity"/></svg>', refresh: '<svg><use href="#i-refresh"/></svg>',
        queueTop: '<svg><use href="#i-queue-top"/></svg>', queueUp: '<svg><use href="#i-queue-up"/></svg>',
        queueDown: '<svg><use href="#i-queue-down"/></svg>', queueBottom: '<svg><use href="#i-queue-bottom"/></svg>'
    });

    const $ = (selector, root = document) => root.querySelector(selector);
    const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
    const state = {
        torrents: new Map(),
        selected: new Set(),
        pendingRemovals: new Set(),
        contextIds: [],
        session: {},
        filter: 'all',
        privacy: '',
        tracker: '',
        search: '',
        sort: localStorage.getItem('tx-sort') || 'name',
        reverse: localStorage.getItem('tx-sort-reverse') === 'true',
        highContrast: localStorage.getItem('tx-contrast') === 'true',
        refreshSeconds: Number(localStorage.getItem('tx-refresh')) || DEFAULT_REFRESH_SECONDS,
        notifications: localStorage.getItem('tx-notifications') === 'true',
        lastSelectedId: null,
        detailIds: [],
        detailTab: 'info',
        detailsOpen: false,
        polling: false,
        pollTimer: null,
        dragDepth: 0,
        previousDone: new Map()
    };

    class TransmissionRpc {
        static SESSION_HEADER = 'X-Transmission-Session-Id';
        static SESSION_STORAGE_KEY = 'transmission-session-id';
        static DIALECT_STORAGE_KEY = 'transmission-rpc-dialect';
        static MAX_ATTEMPTS = 6;

        constructor(url) {
            this.url = url;
            this.sessionId = sessionStorage.getItem(TransmissionRpc.SESSION_STORAGE_KEY) || '';
            this.dialect = sessionStorage.getItem(TransmissionRpc.DIALECT_STORAGE_KEY) || 'modern';
            this.dialectConfirmed = Object.prototype.hasOwnProperty.call(sessionStorage, TransmissionRpc.DIALECT_STORAGE_KEY);
            this.sequence = 0;
        }

        static legacyFieldName(name) {
            const aliases = {
                file_count: 'file-count',
                primary_mime_type: null,
                webseeds_ex: null
            };
            if (Object.prototype.hasOwnProperty.call(aliases, name)) return aliases[name];
            return name.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
        }

        static legacyArguments(method, params = {}) {
            const arguments_ = {};
            for (const [key, value] of Object.entries(params)) {
                if (key === 'fields') {
                    arguments_.fields = value
                        .map(TransmissionRpc.legacyFieldName)
                        .filter(Boolean);
                } else {
                    const legacyArgumentNames = {bandwidth_priority: 'bandwidthPriority'};
                    arguments_[legacyArgumentNames[key] || key.replaceAll('_', '-')] = value;
                }
            }

            // Legacy port-test has no per-protocol argument.
            if (method === 'port_test') return {};
            return arguments_;
        }

        static normalizeKey(key) {
            return key
                .replaceAll('-', '_')
                .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
                .toLowerCase();
        }

        static normalize(value) {
            if (Array.isArray(value)) return value.map(item => TransmissionRpc.normalize(item));
            if (!value || typeof value !== 'object') return value;
            return Object.fromEntries(Object.entries(value).map(([key, item]) => [
                TransmissionRpc.normalizeKey(key),
                TransmissionRpc.normalize(item)
            ]));
        }

        makeBody(method, params) {
            if (this.dialect === 'legacy') {
                const body = {
                    method: method.replaceAll('_', '-'),
                    arguments: TransmissionRpc.legacyArguments(method, params)
                };
                body.tag = ++this.sequence;
                return body;
            }

            const body = {jsonrpc: '2.0', id: `web-${++this.sequence}`, method};
            if (params && Object.keys(params).length) body.params = params;
            return body;
        }

        async request(method, params) {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 15000);

            try {
                for (let attempt = 0; attempt < TransmissionRpc.MAX_ATTEMPTS; attempt++) {
                    const headers = {
                        'Cache-Control': 'no-cache',
                        'Content-Type': 'application/json',
                        Pragma: 'no-cache'
                    };
                    if (this.sessionId) headers[TransmissionRpc.SESSION_HEADER] = this.sessionId;

                    const response = await fetch(this.url, {
                        method: 'POST',
                        credentials: 'same-origin',
                        headers,
                        body: JSON.stringify(this.makeBody(method, params)),
                        signal: controller.signal
                    });

                    if (response.status === 409) {
                        const nextSessionId = response.headers.get(TransmissionRpc.SESSION_HEADER);
                        if (!nextSessionId) {
                            throw new Error('Transmission returned HTTP 409 without a session identifier. Check reverse-proxy response headers.');
                        }
                        this.sessionId = nextSessionId;
                        sessionStorage.setItem(TransmissionRpc.SESSION_STORAGE_KEY, nextSessionId);
                        continue;
                    }

                    if (!response.ok) throw new Error(`Transmission returned HTTP ${response.status}.`);
                    if (response.status === 204) return {};

                    const payload = await response.json();
                    if (payload.error) {
                        const error = new Error(payload.error.data?.errorString || payload.error.message || 'RPC request failed.');
                        error.code = payload.error.code;
                        throw error;
                    }

                    const resultText = typeof payload.result === 'string' ? payload.result.toLowerCase() : '';
                    if (!this.dialectConfirmed && resultText.includes('method name not recognized')) {
                        this.dialect = 'legacy';
                        this.dialectConfirmed = true;
                        sessionStorage.setItem(TransmissionRpc.DIALECT_STORAGE_KEY, 'legacy');
                        continue;
                    }

                    if (this.dialect === 'legacy') {
                        if (resultText !== 'success') throw new Error(payload.result || 'Legacy Transmission RPC request failed.');
                        this.dialectConfirmed = true;
                        sessionStorage.setItem(TransmissionRpc.DIALECT_STORAGE_KEY, 'legacy');
                        return TransmissionRpc.normalize(payload.arguments || {});
                    }

                    this.dialectConfirmed = true;
                    sessionStorage.setItem(TransmissionRpc.DIALECT_STORAGE_KEY, 'modern');
                    return payload.result ?? {};
                }

                throw new Error('Transmission RPC negotiation failed after repeated attempts.');
            } catch (error) {
                if (error.name === 'AbortError') throw new Error('Transmission request timed out after 15 seconds.');
                throw error;
            } finally {
                clearTimeout(timeout);
            }
        }
    }

    const rpc = new TransmissionRpc(RPC_URL);

    function icon(name) {
        return ICONS[name] || '';
    }

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, Number(value) || 0));
    }

    function plural(count, word) {
        return `${formatNumber(count)} ${word}${count === 1 ? '' : 's'}`;
    }

    function formatNumber(value, maximumFractionDigits = 1) {
        return new Intl.NumberFormat(undefined, {maximumFractionDigits}).format(Number(value) || 0);
    }

    function formatBytes(bytes) {
        if (!Number.isFinite(Number(bytes)) || bytes < 0) return 'Unknown';
        if (bytes === 0) return '0 B';
        const units = ['B', 'kB', 'MB', 'GB', 'TB', 'PB'];
        const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1000)), units.length - 1);
        return `${formatNumber(bytes / (1000 ** index), index < 2 ? 0 : 2)} ${units[index]}`;
    }

    function formatSpeed(bytesPerSecond) {
        return `${formatBytes(Math.max(0, bytesPerSecond || 0))}/s`;
    }

    function formatRatio(value) {
        if (value === -2) return '∞';
        if (value === -1 || !Number.isFinite(Number(value))) return '—';
        return formatNumber(value, 2);
    }

    function formatDuration(value) {
        const seconds = Number(value);
        if (!Number.isFinite(seconds) || seconds < 0) return 'Unknown';
        const parts = [];
        const days = Math.floor(seconds / 86400);
        const hours = Math.floor((seconds % 86400) / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const remainingSeconds = Math.floor(seconds % 60);
        if (days) parts.push(`${days}d`);
        if (hours) parts.push(`${hours}h`);
        if (minutes) parts.push(`${minutes}m`);
        if (!days && !hours && (!minutes || parts.length < 2)) parts.push(`${remainingSeconds}s`);
        return parts.slice(0, 2).join(' ') || '0s';
    }

    function formatDate(seconds) {
        return seconds ? new Date(seconds * 1000).toLocaleString() : 'N/A';
    }

    function trackerHost(tracker) {
        const announce = tracker?.announce || tracker?.host || tracker?.sitename || '';
        try {
            const normalized = announce.startsWith('udp:') ? announce.replace(/^udp:/, 'http:') : announce;
            return new URL(normalized).hostname || announce;
        } catch {
            return announce;
        }
    }

    function torrentStatus(torrent) {
        if (torrent.error) return torrent.error_string || 'Error';
        const labels = {
            [STATUS.STOPPED]: torrent.is_finished ? 'Seeding complete' : 'Stopped',
            [STATUS.CHECK_WAIT]: 'Queued to verify',
            [STATUS.CHECK]: 'Verifying',
            [STATUS.DOWNLOAD_WAIT]: 'Queued to download',
            [STATUS.DOWNLOAD]: torrent.is_stalled ? 'Downloading · stalled' : 'Downloading',
            [STATUS.SEED_WAIT]: 'Queued to seed',
            [STATUS.SEED]: torrent.is_stalled ? 'Seeding · stalled' : 'Seeding'
        };
        return labels[torrent.status] || 'Unknown';
    }

    function torrentProgress(torrent) {
        if ((torrent.metadata_percent_complete ?? 1) < 1) return clamp(torrent.metadata_percent_complete * 100, 0, 100);
        if (torrent.status === STATUS.CHECK) return clamp(torrent.recheck_progress * 100, 0, 100);
        return clamp(torrent.percent_done * 100, 0, 100);
    }

    function torrentClass(torrent) {
        if (torrent.error) return 'error';
        if (torrent.status === STATUS.STOPPED) return 'paused';
        if (torrent.status === STATUS.CHECK || torrent.status === STATUS.CHECK_WAIT) return 'verifying';
        if (torrent.status === STATUS.SEED || torrent.status === STATUS.SEED_WAIT) return 'seeding';
        return 'downloading';
    }

    function matchesStatus(torrent, mode) {
        switch (mode) {
            case 'active':
                return torrent.rate_download > 0 || torrent.rate_upload > 0 || torrent.status === STATUS.CHECK;
            case 'downloading':
                return torrent.status === STATUS.DOWNLOAD || torrent.status === STATUS.DOWNLOAD_WAIT;
            case 'seeding':
                return torrent.status === STATUS.SEED || torrent.status === STATUS.SEED_WAIT;
            case 'paused':
                return torrent.status === STATUS.STOPPED;
            case 'finished':
                return Boolean(torrent.is_finished);
            case 'error':
                return Boolean(torrent.error);
            default:
                return true;
        }
    }

    function isVisible(torrent) {
        if (!matchesStatus(torrent, state.filter)) return false;
        if (state.privacy === 'private' && !torrent.is_private) return false;
        if (state.privacy === 'public' && torrent.is_private) return false;
        if (state.tracker && !(torrent.trackers || []).some(tracker => trackerHost(tracker).toLowerCase() === state.tracker)) return false;
        if (state.search) {
            const haystack = `${torrent.name || ''}\n${(torrent.labels || []).join('\n')}`.toLowerCase();
            if (!haystack.includes(state.search)) return false;
        }
        return true;
    }

    function sortedVisibleTorrents() {
        const comparators = {
            name: (a, b) => (a.name || '').localeCompare(b.name || '', undefined, {sensitivity: 'base'}),
            age: (a, b) => (b.added_date || 0) - (a.added_date || 0),
            activity: (a, b) => ((b.rate_download || 0) + (b.rate_upload || 0)) - ((a.rate_download || 0) + (a.rate_upload || 0)),
            progress: (a, b) => torrentProgress(a) - torrentProgress(b),
            queue: (a, b) => (a.queue_position || 0) - (b.queue_position || 0),
            ratio: (a, b) => (b.upload_ratio || 0) - (a.upload_ratio || 0),
            size: (a, b) => (a.total_size || 0) - (b.total_size || 0),
            state: (a, b) => (b.status || 0) - (a.status || 0)
        };
        const comparator = comparators[state.sort] || comparators.name;
        const torrents = [...state.torrents.values()].filter(isVisible).sort((a, b) => comparator(a, b) || a.id - b.id);
        return state.reverse ? torrents.reverse() : torrents;
    }

    function toast(title, message = '', type = '') {
        const node = document.createElement('div');
        node.className = `toast ${type}`;
        const strong = document.createElement('strong');
        strong.textContent = title;
        const span = document.createElement('span');
        span.textContent = message;
        node.append(strong);
        if (message) node.append(span);
        const modal = $('#modal');
        if (modal.open) {
            node.classList.add('modal-toast');
            modal.append(node);
        } else {
            $('#toast-region').append(node);
        }
        setTimeout(() => node.remove(), 4500);
    }

    function setConnection(status, text) {
        const element = $('#connection');
        element.classList.remove('online', 'offline');
        if (status) element.classList.add(status);
        element.setAttribute('aria-label', text);
        $('.sr-only', element).textContent = text;
    }

    function reportError(error, title = 'Request failed') {
        console.error(error);
        setConnection('offline', 'Disconnected');
        toast(title, error?.message || String(error), 'error');
    }

    function checkCompletionNotifications(torrents) {
        for (const torrent of torrents) {
            const done = (torrent.percent_done || 0) >= 1;
            if (state.notifications && 'Notification' in window && done && state.previousDone.get(torrent.id) === false && Notification.permission === 'granted') {
                new Notification('Download complete', {body: torrent.name || 'Torrent completed'});
            }
            state.previousDone.set(torrent.id, done);
        }
    }

    async function loadSession() {
        state.session = await rpc.request('session_get');
        state.refreshSeconds = Number(localStorage.getItem('tx-refresh')) || state.refreshSeconds;
        $('#alt-speed').classList.toggle('active', Boolean(state.session.alt_speed_enabled));
        $('#alt-speed').setAttribute('aria-pressed', String(Boolean(state.session.alt_speed_enabled)));
    }

    async function refreshTorrents({quiet = true} = {}) {
        if (state.polling) return;
        state.polling = true;
        try {
            const result = await rpc.request('torrent_get', {fields: TORRENT_FIELDS});
            const incoming = result.torrents || [];
            const incomingIds = new Set(incoming.map(torrent => torrent.id));
            checkCompletionNotifications(incoming.filter(torrent => !state.pendingRemovals.has(torrent.id)));
            for (const torrent of incoming) {
                if (!state.pendingRemovals.has(torrent.id)) state.torrents.set(torrent.id, {...state.torrents.get(torrent.id), ...torrent});
            }
            for (const id of result.removed || []) {
                state.torrents.delete(id);
                state.selected.delete(id);
                state.pendingRemovals.delete(id);
            }
            for (const id of [...state.pendingRemovals]) if (!incomingIds.has(id)) state.pendingRemovals.delete(id);
            setConnection('online', 'Connected');
            render();
            if (!quiet) toast('Torrents refreshed', '', 'success');
        } catch (error) {
            reportError(error, 'Could not refresh torrents');
        } finally {
            state.polling = false;
            schedulePoll();
        }
    }

    function schedulePoll() {
        clearTimeout(state.pollTimer);
        state.pollTimer = setTimeout(() => refreshTorrents(), Math.max(2, state.refreshSeconds) * 1000);
    }

    function render() {
        const all = [...state.torrents.values()];
        const visible = sortedVisibleTorrents();
        updateTrackerOptions(all);
        updateSummary(all, visible);
        renderTorrentRows(visible);
        updateSelectionUi();
        if (state.detailsOpen) renderDetails();
    }

    function updateTrackerOptions(torrents) {
        const select = $('#tracker-filter');
        const trackers = [...new Set(torrents.flatMap(t => (t.trackers || []).map(trackerHost)).filter(Boolean).map(x => x.toLowerCase()))].sort();
        const current = state.tracker;
        select.replaceChildren(new Option('All trackers', ''), ...trackers.map(host => new Option(host, host)));
        select.value = current;
        if (current && !trackers.includes(current)) select.classList.add('stale-filter');
        else select.classList.remove('stale-filter');
    }

    function updateSummary(all, visible) {
        const counts = {all: all.length, active: 0, downloading: 0, seeding: 0, paused: 0, finished: 0, error: 0};
        let down = 0;
        let up = 0;
        for (const torrent of all) {
            down += torrent.rate_download || 0;
            up += torrent.rate_upload || 0;
            for (const mode of ['active', 'downloading', 'seeding', 'paused', 'finished', 'error']) if (matchesStatus(torrent, mode)) counts[mode]++;
        }
        $('#speed-down').textContent = formatSpeed(down);
        $('#speed-up').textContent = formatSpeed(up);
        $('#active-total').textContent = counts.active;
        $('#torrent-total').textContent = counts.all;
        for (const [key, value] of Object.entries(counts)) $(`#count-${key}`).textContent = value;
        $('#visible-count').textContent = plural(visible.length, 'torrent');
        const parts = [state.filter === 'all' ? 'All torrents' : `${state.filter[0].toUpperCase()}${state.filter.slice(1)} torrents`];
        if (state.privacy) parts.push(`${state.privacy} only`);
        if (state.tracker) parts.push(state.tracker);
        if (state.search) parts.push(`matching “${state.search}”`);
        $('#filter-summary').textContent = parts.join(' · ');
    }

    function renderTorrentRows(torrents) {
        const list = $('#torrent-list');
        const fragment = document.createDocumentFragment();
        for (const torrent of torrents) fragment.append(createTorrentRow(torrent));
        list.replaceChildren(fragment);
        const empty = torrents.length === 0;
        $('#empty-state').hidden = !empty;
        $('#empty-add').hidden = state.torrents.size > 0;
        $('#empty-message').textContent = state.torrents.size ? 'No torrents match the current filters.' : 'Add a torrent file, magnet link, or URL to begin.';
    }

    function createTorrentRow(torrent) {
        const progress = torrentProgress(torrent);
        const row = document.createElement('li');
        row.className = `torrent-row ${torrentClass(torrent)}${state.selected.has(torrent.id) ? ' selected' : ''}`;
        row.dataset.id = torrent.id;
        row.tabIndex = 0;
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', String(state.selected.has(torrent.id)));

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'torrent-check';
        checkbox.checked = state.selected.has(torrent.id);
        checkbox.setAttribute('aria-label', `Select ${torrent.name || 'torrent'}`);

        const main = document.createElement('div');
        main.className = 'torrent-main';
        const titleLine = document.createElement('div');
        titleLine.className = 'torrent-title-line';
        const name = document.createElement('span');
        name.className = 'torrent-name';
        name.textContent = torrent.name || 'Unknown torrent';
        name.title = torrent.name || '';
        titleLine.append(name);
        for (const label of (torrent.labels || []).slice(0, 2)) {
            const badge = document.createElement('span');
            badge.className = 'torrent-label';
            badge.textContent = label;
            titleLine.append(badge);
        }
        const progressLine = document.createElement('div');
        progressLine.className = 'progress-line';
        const track = document.createElement('div');
        track.className = 'progress-track';
        track.setAttribute('role', 'progressbar');
        track.setAttribute('aria-label', `Progress for ${torrent.name || 'torrent'}`);
        track.setAttribute('aria-valuemin', '0');
        track.setAttribute('aria-valuemax', '100');
        track.setAttribute('aria-valuenow', progress.toFixed(1));
        const fill = document.createElement('span');
        fill.className = 'progress-fill';
        fill.style.width = `${progress}%`;
        track.append(fill);
        const percent = document.createElement('span');
        percent.className = 'progress-percent';
        percent.textContent = `${formatNumber(progress, progress < 100 ? 1 : 0)}%`;
        progressLine.append(track, percent);
        const subline = document.createElement('div');
        subline.className = 'torrent-subline';
        const completeBytes = Math.max(0, (torrent.size_when_done || 0) - (torrent.left_until_done || 0));
        const uploadedBytes = Math.max(0, Number(torrent.uploaded_ever) || 0);
        subline.textContent = `Downloaded ${formatBytes(completeBytes)} of ${formatBytes(torrent.size_when_done || torrent.total_size || 0)}${uploadedBytes > 0 ? ` · Uploaded ${formatBytes(uploadedBytes)}` : ''}${torrent.status !== STATUS.STOPPED && torrent.eta >= 0 ? ` · ${formatDuration(torrent.eta)} remaining` : ''}`;
        main.append(titleLine, progressLine, subline);

        const stateCell = document.createElement('div');
        stateCell.className = 'state-cell';
        const badge = document.createElement('span');
        badge.className = 'state-badge';
        badge.textContent = torrentStatus(torrent);
        badge.title = torrent.error_string || '';
        stateCell.append(badge);
        const transfer = document.createElement('div');
        transfer.className = 'transfer-cell';
        const down = document.createElement('span');
        down.className = 'down';
        down.innerHTML = '<svg><use href="#i-download"/></svg>';
        down.append(document.createTextNode(formatSpeed(torrent.rate_download || 0)));
        const up = document.createElement('span');
        up.className = 'up';
        up.innerHTML = '<svg><use href="#i-upload"/></svg>';
        up.append(document.createTextNode(formatSpeed(torrent.rate_upload || 0)));
        transfer.append(down, up);
        const priority = document.createElement('div');
        priority.className = 'priority-cell queue-cell';
        const queueControls = document.createElement('span');
        queueControls.className = 'queue-inline-controls';
        const queuePosition = document.createElement('span');
        queuePosition.className = 'queue-position';
        queuePosition.textContent = Number.isFinite(Number(torrent.queue_position)) ? `#${Number(torrent.queue_position) + 1}` : '—';
        queuePosition.title = 'Queue position';
        const queueButton = (label, action, symbol) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'queue-move-button';
            button.textContent = symbol;
            button.title = label;
            button.setAttribute('aria-label', `${label} ${torrent.name || 'torrent'}`);
            button.addEventListener('click', event => {
                event.stopPropagation();
                handleAction(action, [torrent.id]);
            });
            return button;
        };
        queueControls.append(queueButton('Move up in queue', 'queue-up', '↑'), queuePosition, queueButton('Move down in queue', 'queue-down', '↓'));
        const bandwidthPriority = Number(torrent.bandwidth_priority) || 0;
        const priorityName = bandwidthPriority > 0 ? 'High' : bandwidthPriority < 0 ? 'Low' : 'Normal';
        const priorityBlock = document.createElement('button');
        priorityBlock.type = 'button';
        priorityBlock.className = `torrent-priority-block ${priorityName.toLowerCase()}`;
        priorityBlock.textContent = priorityName.charAt(0);
        priorityBlock.title = `${priorityName} torrent priority — click to change`;
        priorityBlock.setAttribute('aria-label', priorityBlock.title);
        priorityBlock.addEventListener('click', event => {
            event.stopPropagation();
            changeTorrentPriority(torrent.id, bandwidthPriority >= 1 ? -1 : bandwidthPriority + 1);
        });
        priority.append(queueControls, priorityBlock);
        const ratio = document.createElement('div');
        ratio.className = 'ratio-cell';
        ratio.textContent = formatRatio(torrent.upload_ratio);
        const menu = document.createElement('button');
        menu.type = 'button';
        menu.className = 'row-menu';
        menu.innerHTML = icon('more');
        menu.setAttribute('aria-label', `Actions for ${torrent.name || 'torrent'}`);
        menu.addEventListener('click', event => {
            event.stopPropagation();
            showTorrentMenu(event.currentTarget, torrent.id);
        });
        row.append(checkbox, main, stateCell, transfer, priority, ratio, menu);
        checkbox.addEventListener('click', event => event.stopPropagation());
        checkbox.addEventListener('change', () => toggleSelection(torrent.id));
        row.addEventListener('click', event => {
            if (!event.target.closest('button, input')) openDetails([torrent.id]);
        });
        row.addEventListener('contextmenu', event => {
            event.preventDefault();
            showTorrentMenuAt(event.clientX, event.clientY, torrent.id);
        });
        row.addEventListener('keydown', event => {
            if (event.key === 'Enter') {
                event.preventDefault();
                openDetails([torrent.id]);
            }
        });
        return row;
    }

    function toggleSelection(id) {
        state.selected.has(id) ? state.selected.delete(id) : state.selected.add(id);
        state.lastSelectedId = id;
        render();
    }

    function selectOnlyIfNeeded(id) {
        if (!state.selected.has(id)) {
            state.selected.clear();
            state.selected.add(id);
            state.lastSelectedId = id;
            render();
        }
    }

    function selectedIds() {
        return [...state.selected].filter(id => state.torrents.has(id));
    }

    function selectedTorrents() {
        return selectedIds().map(id => state.torrents.get(id));
    }

    function updateSelectionUi() {
        const torrents = selectedTorrents();
        const count = torrents.length;
        const canStart = torrents.some(torrent => torrent.status === STATUS.STOPPED);
        const canStop = torrents.some(torrent => torrent.status !== STATUS.STOPPED);
        const setEnabled = (action, enabled) => {
            $$(`.selection-action[data-action="${action}"], #selection-bar [data-action="${action}"]`).forEach(button => {
                button.disabled = !enabled;
            });
        };

        setEnabled('start', canStart);
        setEnabled('stop', canStop);
        setEnabled('remove', count > 0);
        setEnabled('verify', count > 0);
        setEnabled('details', count > 0);
        const visibleIds = sortedVisibleTorrents().map(torrent => torrent.id);
        const visibleSelected = visibleIds.filter(id => state.selected.has(id)).length;
        const selectAll = $('#select-all-torrents');
        selectAll.disabled = visibleIds.length === 0;
        selectAll.checked = visibleIds.length > 0 && visibleSelected === visibleIds.length;
        selectAll.indeterminate = visibleSelected > 0 && visibleSelected < visibleIds.length;
        $('#selected-count').textContent = count;
        $('#selection-bar').classList.toggle('visible', count > 0);
        $('#selection-bar').setAttribute('aria-hidden', String(count === 0));
    }

    async function torrentAction(method, ids = selectedIds(), params = {}) {
        if (!ids.length) return;
        try {
            await rpc.request(method, {...params, ids});
            await refreshTorrents();
        } catch (error) {
            reportError(error);
        }
    }

    async function changeTorrentPriority(id, value) {
        try {
            await rpc.request('torrent_set', {ids: [id], bandwidth_priority: value});
            const torrent = state.torrents.get(id);
            if (torrent) torrent.bandwidth_priority = value;
            render();
            await refreshTorrents();
        } catch (error) {
            reportError(error, 'Torrent priority is not supported by this daemon');
        }
    }

    async function handleAction(action, explicitIds = null) {
        const ids = explicitIds || selectedIds();
        closePopup();
        switch (action) {
            case 'start':
                return torrentAction('torrent_start', ids);
            case 'start-now':
                return torrentAction('torrent_start_now', ids);
            case 'stop':
                return torrentAction('torrent_stop', ids);
            case 'verify':
                return torrentAction('torrent_verify', ids);
            case 'reannounce':
                return torrentAction('torrent_reannounce', ids);
            case 'queue-top':
                return torrentAction('queue_move_top', ids);
            case 'queue-up':
                return torrentAction('queue_move_up', ids);
            case 'queue-down':
                return torrentAction('queue_move_down', ids);
            case 'queue-bottom':
                return torrentAction('queue_move_bottom', ids);
            case 'priority-high':
                return torrentAction('torrent_set', ids, {bandwidth_priority: 1});
            case 'priority-normal':
                return torrentAction('torrent_set', ids, {bandwidth_priority: 0});
            case 'priority-low':
                return torrentAction('torrent_set', ids, {bandwidth_priority: -1});
            case 'details':
                return openDetails(ids);
            case 'rename':
                return showRenameDialog(ids);
            case 'labels':
                return showLabelsDialog(ids);
            case 'move':
                return showMoveDialog(ids);
            case 'remove':
                return showRemoveDialog(ids);
            case 'deselect':
                state.selected.clear();
                return render();
            case 'select-all':
                for (const torrent of sortedVisibleTorrents()) state.selected.add(torrent.id);
                return render();
            case 'start-all':
                return torrentAction('torrent_start', [...state.torrents.keys()]);
            case 'stop-all':
                return torrentAction('torrent_stop', [...state.torrents.keys()]);
            default:
                return undefined;
        }
    }

    function popupButton(label, action, iconName, className = '', enabled = true) {
        const actionIds = [...state.contextIds];
        const button = document.createElement('button');
        button.type = 'button';
        button.className = className;
        button.disabled = !enabled;
        button.innerHTML = icon(iconName);
        button.append(document.createTextNode(label));
        button.addEventListener('click', () => handleAction(action, actionIds.length ? actionIds : null));
        return button;
    }

    function popupTitle(text) {
        const node = document.createElement('div');
        node.className = 'menu-title';
        node.textContent = text;
        return node;
    }

    function divider() {
        return document.createElement('hr');
    }

    function positionPopup(x, y) {
        const menu = $('#popup-menu');
        menu.hidden = false;
        requestAnimationFrame(() => {
            menu.style.left = `${clamp(x, 8, innerWidth - menu.offsetWidth - 8)}px`;
            menu.style.top = `${clamp(y, 8, innerHeight - menu.offsetHeight - 8)}px`;
        });
    }

    function showTorrentMenu(anchor, id) {
        const rect = anchor.getBoundingClientRect();
        showTorrentMenuAt(rect.right - 230, rect.bottom + 4, id);
    }

    function showTorrentMenuAt(x, y, id) {
        state.contextIds = [id];
        const torrent = state.torrents.get(id);
        const isStopped = torrent?.status === STATUS.STOPPED;
        const isChecking = torrent?.status === STATUS.CHECK || torrent?.status === STATUS.CHECK_WAIT;
        const canReannounce = torrent?.status === STATUS.DOWNLOAD || torrent?.status === STATUS.DOWNLOAD_WAIT ||
            torrent?.status === STATUS.SEED || torrent?.status === STATUS.SEED_WAIT;
        const menu = $('#popup-menu');
        menu.replaceChildren(
            popupTitle('Torrent'),
            popupButton('Start', 'start', 'play', '', isStopped),
            popupButton('Start now', 'start-now', 'play', '', isStopped),
            popupButton('Stop', 'stop', 'pause', '', Boolean(torrent) && !isStopped),
            popupButton('Verify local data', 'verify', 'check', '', Boolean(torrent) && !isChecking),
            popupButton('Ask tracker for more peers', 'reannounce', 'refresh', '', canReannounce),
            popupButton('Details', 'details', 'info', '', Boolean(torrent)),
            divider(),
            popupButton('Remove…', 'remove', 'trash', 'danger-text', Boolean(torrent))
        );
        positionPopup(x, y);
    }

    function showMoreMenu() {
        state.contextIds = [];
        const anchor = $('#more-button');
        const rect = anchor.getBoundingClientRect();
        const menu = $('#popup-menu');
        menu.replaceChildren(popupTitle('Information'));
        for (const [label, callback] of [
            ['Statistics', showStatisticsDialog],
            ['Keyboard shortcuts', showShortcutsDialog],
            ['About Transmission', showAboutDialog]
        ]) {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = label;
            button.addEventListener('click', () => {
                closePopup();
                callback();
            });
            menu.append(button);
        }
        positionPopup(rect.right - 230, rect.bottom + 5);
        anchor.setAttribute('aria-expanded', 'true');
    }

    function closePopup() {
        $('#popup-menu').hidden = true;
        $('#more-button').setAttribute('aria-expanded', 'false');
    }

    function openModal({
                           title,
                           subtitle = '',
                           body,
                           confirmText = 'Save',
                           cancelText = 'Cancel',
                           danger = false,
                           hideConfirm = false,
                           wide = false,
                           onConfirm
                       }) {
        const modal = $('#modal');
        $('#modal-title').textContent = title;
        $('#modal-subtitle').textContent = subtitle;
        $('#modal-subtitle').hidden = !subtitle;
        $('#modal-body').replaceChildren(body);
        $('#modal-confirm').textContent = confirmText;
        $('#modal-cancel').textContent = cancelText;
        $('#modal-confirm').hidden = hideConfirm;
        $('#modal-confirm').classList.toggle('danger', danger);
        modal.classList.toggle('wide', wide);
        modal.onclose = null;
        $('#modal-form').onsubmit = async event => {
            const submitter = event.submitter;
            if (!submitter || submitter.value === 'cancel') return;
            event.preventDefault();
            const button = $('#modal-confirm');
            button.disabled = true;
            try {
                const shouldClose = await onConfirm?.();
                if (shouldClose !== false) modal.close();
            } catch (error) {
                reportError(error);
            } finally {
                button.disabled = false;
            }
        };
        modal.showModal();
    }

    function formGrid() {
        const form = document.createElement('div');
        form.className = 'form-grid';
        return form;
    }

    function addField(form, labelText, input, helpText = '') {
        const label = document.createElement('label');
        label.textContent = labelText;
        if (input.id) label.htmlFor = input.id;
        form.append(label, input);
        if (helpText) {
            const blank = document.createElement('span');
            const help = document.createElement('span');
            help.className = 'help';
            help.textContent = helpText;
            form.append(blank, help);
        }
    }

    function input(type, id, value = '') {
        const element = document.createElement('input');
        element.type = type;
        element.id = id;
        if (type === 'checkbox') element.checked = Boolean(value); else element.value = value ?? '';
        return element;
    }

    function sectionTitle(text) {
        const title = document.createElement('div');
        title.className = 'section-title';
        title.textContent = text;
        return title;
    }

    function showAddDialog(files = null, initialUrl = '') {
        const form = formGrid();
        form.append(sectionTitle('Torrent source'));
        const fileInput = input('file', 'add-files');
        fileInput.multiple = true;
        fileInput.accept = '.torrent,application/x-bittorrent';
        const fileWrap = document.createElement('div');
        fileWrap.className = 'file-drop';
        fileWrap.append(fileInput);
        addField(form, 'Torrent files', fileWrap);
        if (files?.length) {
            try {
                fileInput.files = files;
            } catch { /* Some browsers make FileList read-only. */
            }
        }
        const url = input('text', 'add-url', initialUrl);
        url.placeholder = 'Magnet link, URL, or 40-character hash';
        addField(form, 'URL or magnet', url);
        const destination = input('text', 'add-destination', state.session.download_dir || '');
        addField(form, 'Destination folder', destination);
        const spaceLabel = document.createElement('span');
        spaceLabel.className = 'help';
        spaceLabel.textContent = 'Checking available space…';
        form.append(document.createElement('span'), spaceLabel);
        const checkSpace = async () => {
            try {
                const result = await rpc.request('free_space', {path: destination.value.trim()});
                spaceLabel.textContent = result.size_bytes >= 0 ? `${formatBytes(result.size_bytes)} available` : 'Available space unknown';
            } catch {
                spaceLabel.textContent = 'Available space could not be checked';
            }
        };
        destination.addEventListener('change', checkSpace);
        checkSpace();
        const start = input('checkbox', 'add-start', state.session.start_added_torrents !== false);
        const checkWrap = document.createElement('label');
        checkWrap.className = 'check-field';
        checkWrap.append(start, document.createTextNode('Start when added'));
        form.append(document.createElement('span'), checkWrap);
        openModal({
            title: 'Add torrents',
            subtitle: 'Add torrent files, a magnet link, URL, or info hash.',
            body: form,
            confirmText: 'Add',
            onConfirm: async () => {
                const selectedFiles = [...fileInput.files];
                let link = url.value.trim();
                if (!selectedFiles.length && !link) {
                    toast('Choose a torrent source', 'Select a file or enter a link.', 'error');
                    return false;
                }
                if (/^[\da-f]{40}$/i.test(link)) link = `magnet:?xt=urn:btih:${link}`;
                const common = {download_dir: destination.value.trim(), paused: !start.checked};
                const tasks = selectedFiles.map(async file => rpc.request('torrent_add', {
                    ...common,
                    metainfo: await fileToBase64(file)
                }));
                if (link) tasks.push(rpc.request('torrent_add', {...common, filename: link}));
                const results = await Promise.allSettled(tasks);
                const failed = results.filter(result => result.status === 'rejected');
                if (failed.length) toast('Some torrents were not added', failed.map(result => result.reason.message).join('; '), 'error');
                if (failed.length < results.length) toast('Torrent added', '', 'success');
                await refreshTorrents();
                return failed.length !== results.length;
            }
        });
        setTimeout(() => url.focus(), 0);
    }

    function fileToBase64(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
            reader.onload = () => resolve(String(reader.result).split(',', 2)[1] || '');
            reader.readAsDataURL(file);
        });
    }

    function showRenameDialog(ids = selectedIds()) {
        const torrents = ids.map(id => state.torrents.get(id)).filter(Boolean);
        if (torrents.length !== 1) return toast('Select one torrent', 'Rename works with one torrent at a time.', 'error');
        const form = formGrid();
        const name = input('text', 'rename-value', torrents[0].name || '');
        addField(form, 'New name', name);
        openModal({
            title: 'Rename torrent', body: form, confirmText: 'Rename', onConfirm: async () => {
                const value = name.value.trim();
                if (!value) return false;
                await rpc.request('torrent_rename_path', {ids: [torrents[0].id], path: torrents[0].name, name: value});
                await refreshTorrents();
                return true;
            }
        });
        setTimeout(() => name.select(), 0);
    }

    function showLabelsDialog(ids = selectedIds()) {
        const torrents = ids.map(id => state.torrents.get(id)).filter(Boolean);
        if (!torrents.length) return;
        const form = formGrid();
        const labels = input('text', 'labels-value', torrents.length === 1 ? (torrents[0].labels || []).join(', ') : '');
        addField(form, 'Labels', labels, 'Separate multiple labels with commas.');
        openModal({
            title: 'Edit labels',
            subtitle: plural(torrents.length, 'selected torrent'),
            body: form,
            onConfirm: async () => {
                const value = [...new Set(labels.value.split(',').map(item => item.trim()).filter(Boolean))];
                await rpc.request('torrent_set', {ids, labels: value});
                await refreshTorrents();
                return true;
            }
        });
    }

    function showMoveDialog(ids = selectedIds()) {
        const torrents = ids.map(id => state.torrents.get(id)).filter(Boolean);
        if (!torrents.length) return;
        const form = formGrid();
        const path = input('text', 'move-path', torrents[0].download_dir || state.session.download_dir || '');
        addField(form, 'New location', path);
        openModal({
            title: 'Set torrent location',
            subtitle: 'Transmission will move existing data to this folder.',
            body: form,
            confirmText: 'Move',
            onConfirm: async () => {
                if (!path.value.trim()) return false;
                await rpc.request('torrent_set_location', {ids, location: path.value.trim(), move: true});
                await refreshTorrents();
                return true;
            }
        });
    }

    function showRemoveDialog(ids = selectedIds()) {
        const torrents = ids.map(id => state.torrents.get(id)).filter(Boolean);
        if (!torrents.length) return;
        const form = formGrid();
        const warning = document.createElement('div');
        warning.className = 'warning full';
        warning.textContent = `Remove ${plural(torrents.length, 'torrent')} from Transmission?`;
        const removeData = input('checkbox', 'remove-data', false);
        const label = document.createElement('label');
        label.className = 'check-field full';
        label.append(removeData, document.createTextNode('Also permanently delete downloaded data'));
        form.append(warning, label);
        openModal({
            title: 'Remove torrents',
            subtitle: 'This action cannot be undone.',
            body: form,
            confirmText: 'Remove',
            danger: true,
            onConfirm: async () => {
                await rpc.request('torrent_remove', {ids, delete_local_data: removeData.checked});
                for (const id of ids) {
                    state.pendingRemovals.add(id);
                    state.torrents.delete(id);
                    state.selected.delete(id);
                    state.previousDone.delete(id);
                }
                state.detailIds = state.detailIds.filter(id => !ids.includes(id));
                if (!state.detailIds.length) closeDetails();
                render();
                await refreshTorrents();
                return true;
            }
        });
    }

    async function openDetails(ids = selectedIds()) {
        const availableIds = ids.filter(id => state.torrents.has(id));
        if (!availableIds.length) return;
        state.detailIds = availableIds;
        state.detailsOpen = true;
        $('#details-panel').classList.add('open');
        $('#details-backdrop').classList.add('open');
        $('#details-panel').setAttribute('aria-hidden', 'false');
        $('#details-content').innerHTML = '<div class="loading">Loading torrent details…</div>';
        try {
            const result = await rpc.request('torrent_get', {
                ids: availableIds,
                fields: [...new Set([...TORRENT_FIELDS, ...EXTRA_FIELDS])]
            });
            for (const torrent of result.torrents || []) state.torrents.set(torrent.id, {...state.torrents.get(torrent.id), ...torrent});
            renderDetails();
        } catch (error) {
            reportError(error, 'Could not load torrent details');
        }
    }

    function closeDetails() {
        state.detailsOpen = false;
        state.detailIds = [];
        $('#details-panel').classList.remove('open');
        $('#details-backdrop').classList.remove('open');
        $('#details-panel').setAttribute('aria-hidden', 'true');
    }

    function detailTorrents() {
        return state.detailIds.map(id => state.torrents.get(id)).filter(Boolean);
    }

    function renderDetails() {
        const torrents = detailTorrents();
        if (!torrents.length) return closeDetails();
        $('#details-title').textContent = torrents.length === 1 ? torrents[0].name : plural(torrents.length, 'torrent');
        $$('.detail-tabs button').forEach(button => button.classList.toggle('active', button.dataset.detailTab === state.detailTab));
        const content = $('#details-content');
        content.replaceChildren();
        if (state.detailTab === 'info') content.append(renderInfoDetails(torrents));
        else if (state.detailTab === 'files') content.append(renderFilesDetails(torrents));
        else if (state.detailTab === 'peers') content.append(renderPeersDetails(torrents));
        else content.append(renderTrackerDetails(torrents));
    }

    function detailsSection(title, entries) {
        const section = document.createElement('section');
        section.className = 'detail-section';
        const heading = document.createElement('h3');
        heading.textContent = title;
        const dl = document.createElement('dl');
        dl.className = 'detail-grid';
        for (const [key, value] of entries) {
            const dt = document.createElement('dt');
            dt.textContent = key;
            const dd = document.createElement('dd');
            dd.textContent = value ?? 'N/A';
            dl.append(dt, dd);
        }
        section.append(heading, dl);
        return section;
    }

    function renderInfoDetails(torrents) {
        const root = document.createDocumentFragment();
        const ids = torrents.map(torrent => torrent.id);
        const total = key => torrents.reduce((sum, torrent) => sum + (Number(torrent[key]) || 0), 0);

        const inlineButton = (label, iconName, callback) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'inline-edit-button';
            button.innerHTML = icon(iconName);
            button.title = label;
            button.setAttribute('aria-label', label);
            button.addEventListener('click', callback);
            return button;
        };
        const valueWithAction = (value, label, iconName, callback) => {
            const wrap = document.createElement('span');
            wrap.className = 'detail-value-action';
            const text = document.createElement('span');
            text.textContent = value ?? 'N/A';
            wrap.append(text, inlineButton(label, iconName, callback));
            return wrap;
        };
        const interactiveSection = (title, entries) => {
            const section = document.createElement('section');
            section.className = 'detail-section';
            const heading = document.createElement('h3');
            heading.textContent = title;
            const list = document.createElement('dl');
            list.className = 'detail-grid detail-grid-interactive';
            for (const [label, value] of entries) {
                const term = document.createElement('dt');
                term.textContent = label;
                const description = document.createElement('dd');
                if (value instanceof Node) description.append(value);
                else description.textContent = value ?? 'N/A';
                list.append(term, description);
            }
            section.append(heading, list);
            return section;
        };
        const queueWidget = document.createElement('span');
        queueWidget.className = 'activity-control';
        const queueValues = torrents.map(torrent => Number(torrent.queue_position));
        const sameQueue = queueValues.every(value => value === queueValues[0]);
        const queueValue = document.createElement('strong');
        queueValue.textContent = sameQueue && Number.isFinite(queueValues[0]) ? `#${queueValues[0] + 1}` : 'Mixed';
        const queueAction = (label, action, iconName) => inlineButton(label, iconName, () => handleAction(action, ids));
        queueWidget.append(
            queueValue,
            queueAction('Move to top', 'queue-top', 'queueTop'),
            queueAction('Move up', 'queue-up', 'queueUp'),
            queueAction('Move down', 'queue-down', 'queueDown'),
            queueAction('Move to bottom', 'queue-bottom', 'queueBottom')
        );

        const priorityWidget = document.createElement('span');
        priorityWidget.className = 'activity-control priority-activity-control';
        const priorityValues = torrents.map(torrent => Number(torrent.bandwidth_priority) || 0);
        const samePriority = priorityValues.every(value => value === priorityValues[0]);
        const currentPriorityName = !samePriority ? 'Mixed' : priorityValues[0] > 0 ? 'High' : priorityValues[0] < 0 ? 'Low' : 'Normal';
        const priorityValue = document.createElement('strong');
        priorityValue.textContent = currentPriorityName;
        priorityWidget.append(priorityValue);
        for (const [label, action, className] of [['Low', 'priority-low', 'low'], ['Normal', 'priority-normal', 'normal'], ['High', 'priority-high', 'high']]) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = `square-control ${className}${samePriority && currentPriorityName === label ? ' active' : ''}`;
            button.textContent = label.charAt(0);
            button.title = `Set ${label.toLowerCase()} priority`;
            button.setAttribute('aria-label', button.title);
            button.addEventListener('click', () => handleAction(action, ids));
            priorityWidget.append(button);
        }

        root.append(interactiveSection('Activity', [
            ['State', torrents.length === 1 ? torrentStatus(torrents[0]) : 'Multiple torrents'],
            ['Progress', `${formatNumber(total('size_when_done') ? ((total('size_when_done') - total('left_until_done')) / total('size_when_done')) * 100 : 100)}%`],
            ['Downloaded', formatBytes(total('downloaded_ever'))],
            ['Uploaded', formatBytes(total('uploaded_ever'))],
            ['Download speed', formatSpeed(total('rate_download'))],
            ['Upload speed', formatSpeed(total('rate_upload'))],
            ['Remaining', torrents.length === 1 ? formatDuration(torrents[0].eta) : 'Mixed'],
            ['Last activity', formatDate(Math.max(...torrents.map(t => t.activity_date || 0)))],
            ['Queue', queueWidget],
            ['Priority', priorityWidget]
        ]));

        if (torrents.length === 1) {
            const torrent = torrents[0];
            root.append(interactiveSection('Details', [
                ['Name', valueWithAction(torrent.name, 'Rename torrent', 'edit', () => showRenameDialog(ids))],
                ['Size', formatBytes(torrent.total_size)],
                ['Location', valueWithAction(torrent.download_dir, 'Set torrent location', 'folder', () => showMoveDialog(ids))],
                ['Hash', torrent.hash_string],
                ['Privacy', torrent.is_private ? 'Private torrent' : 'Public torrent'],
                ['Created by', torrent.creator || 'Unknown'],
                ['Created', formatDate(torrent.date_created)],
                ['Added', formatDate(torrent.added_date)],
                ['Pieces', torrent.piece_count ? `${formatNumber(torrent.piece_count, 0)} × ${formatBytes(torrent.piece_size)}` : 'N/A'],
                ['Labels', valueWithAction((torrent.labels || []).join(', ') || 'None', 'Edit labels', 'tag', () => showLabelsDialog(ids))],
                ['Comment', torrent.comment || 'None'],
                ['Magnet link', torrent.magnet_link || 'N/A']
            ]));
        }
        return root;
    }

    function table(headers) {
        const wrap = document.createElement('div');
        wrap.className = 'data-table-wrap';
        const table = document.createElement('table');
        table.className = 'data-table';
        const head = document.createElement('thead');
        const row = document.createElement('tr');
        for (const text of headers) {
            const th = document.createElement('th');
            th.textContent = text;
            row.append(th);
        }
        head.append(row);
        const body = document.createElement('tbody');
        table.append(head, body);
        wrap.append(table);
        return {wrap, body};
    }

    function priorityControl(label, command, className, indices, torrentId, active = false) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `square-control ${className}${active ? ' active' : ''}`;
        button.textContent = label.charAt(0);
        button.title = `${label} priority`;
        button.setAttribute('aria-label', `${label} priority`);
        button.addEventListener('click', () => changeFileSettings(torrentId, {[command]: indices}));
        return button;
    }

    function fileWantedControl(label, command, indices, torrentId, className = '') {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `file-wanted-button ${className}`;
        button.textContent = label;
        button.addEventListener('click', () => changeFileSettings(torrentId, {[command]: indices}));
        return button;
    }

    async function changeFileSettings(torrentId, params) {
        try {
            await rpc.request('torrent_set', {ids: [torrentId], ...params});
            await openDetails([torrentId]);
        } catch (error) {
            reportError(error, 'Could not update file settings');
        }
    }

    function renderFilesDetails(torrents) {
        if (torrents.length !== 1) {
            const div = document.createElement('div');
            div.className = 'loading';
            div.textContent = 'Open one torrent to manage its files.';
            return div;
        }
        const torrent = torrents[0];
        const files = torrent.files || [];
        const stats = torrent.file_stats || [];
        const root = document.createElement('div');
        root.className = 'file-details';
        if (!files.length) {
            root.className = 'loading';
            root.textContent = 'No file information is available.';
            return root;
        }

        const entries = files.map((file, index) => ({
            file,
            index,
            stat: stats[index] || {},
            displayName: displayFileName(file.name, torrent.name)
        }));
        const allIndices = entries.map(entry => entry.index);
        const allWanted = entries.every(entry => entry.stat.wanted ?? entry.file.wanted ?? true);
        const allUnwanted = entries.every(entry => !(entry.stat.wanted ?? entry.file.wanted ?? true));
        const bulk = document.createElement('div');
        bulk.className = 'file-bulk-actions';
        const bulkTitle = document.createElement('strong');
        bulkTitle.textContent = 'All files';
        bulk.append(
            bulkTitle,
            fileWantedControl(allWanted ? 'Selected' : 'Select all', 'files_wanted', allIndices, torrent.id, `wanted${allWanted ? ' active' : ''}`),
            fileWantedControl(allUnwanted ? 'Unselected' : 'Select none', 'files_unwanted', allIndices, torrent.id, `unwanted${allUnwanted ? ' active' : ''}`),
            priorityControl('Low', 'priority_low', 'low', allIndices, torrent.id),
            priorityControl('Normal', 'priority_normal', 'normal', allIndices, torrent.id),
            priorityControl('High', 'priority_high', 'high', allIndices, torrent.id)
        );

        const fileTree = buildFileTree(entries);
        const tree = document.createElement('div');
        tree.className = 'file-tree';
        renderFileTreeNode(tree, fileTree, torrent, 0);
        root.append(bulk, tree);
        return root;
    }

    function buildFileTree(entries) {
        const root = {name: '', path: '', dirs: new Map(), files: [], indices: []};
        for (const entry of entries) {
            const parts = entry.displayName.replaceAll('\\\\', '/').split('/').filter(Boolean);
            let node = root;
            node.indices.push(entry.index);
            for (const part of parts.slice(0, -1)) {
                const path = node.path ? `${node.path}/${part}` : part;
                if (!node.dirs.has(part)) node.dirs.set(part, {
                    name: part,
                    path,
                    dirs: new Map(),
                    files: [],
                    indices: []
                });
                node = node.dirs.get(part);
                node.indices.push(entry.index);
            }
            entry.leafName = parts.at(-1) || entry.displayName;
            node.files.push(entry);
        }
        return root;
    }

    function renderFileTreeNode(parent, node, torrent, depth) {
        const sortedDirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, {
            numeric: true,
            sensitivity: 'base'
        }));
        for (const dir of sortedDirs) {
            const details = document.createElement('details');
            details.className = 'file-directory';
            details.open = depth < 1;
            const summary = document.createElement('summary');
            const title = document.createElement('strong');
            title.textContent = dir.name;
            const count = document.createElement('span');
            count.className = 'directory-count';
            count.textContent = plural(dir.indices.length, 'file');
            const dirEntries = dir.indices.map(index => ({
                file: torrent.files[index],
                stat: (torrent.file_stats || [])[index] || {}
            }));
            const dirAllWanted = dirEntries.every(entry => entry.stat.wanted ?? entry.file.wanted ?? true);
            const dirAllUnwanted = dirEntries.every(entry => !(entry.stat.wanted ?? entry.file.wanted ?? true));
            const actions = document.createElement('span');
            actions.className = 'directory-actions';
            actions.addEventListener('click', event => event.preventDefault());
            actions.append(
                fileWantedControl(dirAllWanted ? 'Selected' : 'All', 'files_wanted', dir.indices, torrent.id, `wanted${dirAllWanted ? ' active' : ''}`),
                fileWantedControl(dirAllUnwanted ? 'Unselected' : 'None', 'files_unwanted', dir.indices, torrent.id, `unwanted${dirAllUnwanted ? ' active' : ''}`),
                priorityControl('Low', 'priority_low', 'low', dir.indices, torrent.id),
                priorityControl('Normal', 'priority_normal', 'normal', dir.indices, torrent.id),
                priorityControl('High', 'priority_high', 'high', dir.indices, torrent.id)
            );
            summary.append(title, count, actions);
            details.append(summary);
            const children = document.createElement('div');
            children.className = 'directory-children';
            renderFileTreeNode(children, dir, torrent, depth + 1);
            details.append(children);
            parent.append(details);
        }

        const sortedFiles = [...node.files].sort((a, b) => a.leafName.localeCompare(b.leafName, undefined, {
            numeric: true,
            sensitivity: 'base'
        }));
        for (const {
            file,
            index,
            stat,
            leafName
        } of sortedFiles) parent.append(renderFileRow(torrent, file, index, stat, leafName));
    }

    function renderFileRow(torrent, file, index, stat, displayName) {
        const row = document.createElement('div');
        row.className = 'file-tree-row';
        const wanted = input('checkbox', '', stat.wanted ?? file.wanted ?? true);
        wanted.setAttribute('aria-label', `Download ${displayName}`);
        wanted.addEventListener('change', () => changeFileSettings(torrent.id, {[wanted.checked ? 'files_wanted' : 'files_unwanted']: [index]}));
        const name = document.createElement('span');
        name.className = 'file-tree-name';
        name.textContent = displayName;
        name.title = file.name || '';
        const progress = document.createElement('span');
        progress.className = 'file-tree-progress';
        progress.textContent = `${formatNumber(file.length ? ((file.bytes_completed || 0) / file.length) * 100 : 100)}%`;
        const size = document.createElement('span');
        size.className = 'file-tree-size';
        size.textContent = formatBytes(file.length);
        const priorities = document.createElement('span');
        priorities.className = 'priority-squares';
        const currentPriority = Number(stat.priority ?? file.priority ?? 0);
        priorities.append(
            priorityControl('Low', 'priority_low', 'low', [index], torrent.id, currentPriority === -1),
            priorityControl('Normal', 'priority_normal', 'normal', [index], torrent.id, currentPriority === 0),
            priorityControl('High', 'priority_high', 'high', [index], torrent.id, currentPriority === 1)
        );
        row.append(wanted, name, progress, size, priorities);
        return row;
    }

    function displayFileName(fileName, torrentName) {
        const normalized = String(fileName || '').replaceAll('\\\\', '/');
        const slash = normalized.indexOf('/');
        if (slash < 0) return normalized;
        const firstPart = normalized.slice(0, slash);
        return firstPart.localeCompare(String(torrentName || ''), undefined, {sensitivity: 'base'}) === 0 ? normalized.slice(slash + 1) : normalized;
    }

    function renderPeersDetails(torrents) {
        const {wrap, body} = table(['Address', 'Client', 'Up', 'Down', 'Done', 'Flags']);
        let count = 0;
        for (const torrent of torrents) for (const peer of torrent.peers || []) {
            count++;
            const row = document.createElement('tr');
            for (const value of [peer.address, peer.client_name, formatSpeed(peer.rate_to_peer), formatSpeed(peer.rate_to_client), `${formatNumber((peer.progress || 0) * 100)}%`, peer.flag_str]) {
                const cell = document.createElement('td');
                cell.textContent = value || '';
                row.append(cell);
            }
            body.append(row);
        }
        if (!count) {
            const row = document.createElement('tr');
            const cell = document.createElement('td');
            cell.colSpan = 6;
            cell.textContent = 'No connected peers.';
            row.append(cell);
            body.append(row);
        }
        return wrap;
    }

    function renderTrackerDetails(torrents) {
        const root = document.createElement('div');
        let count = 0;
        for (const torrent of torrents) for (const tracker of torrent.tracker_stats || torrent.trackers || []) {
            count++;
            const card = document.createElement('article');
            card.className = 'tracker-card';
            const title = document.createElement('strong');
            title.textContent = trackerHost(tracker) || 'Tracker';
            const url = document.createElement('span');
            url.textContent = tracker.announce || '';
            const status = document.createElement('span');
            status.textContent = tracker.last_announce_result || `Seeders: ${tracker.seeder_count ?? 'N/A'} · Leechers: ${tracker.leecher_count ?? 'N/A'}`;
            card.append(title, url, status);
            root.append(card);
        }
        if (!count) {
            const div = document.createElement('div');
            div.className = 'loading';
            div.textContent = 'No tracker information.';
            root.append(div);
        }
        return root;
    }

    function createPreferenceControl(key, type = 'text', options = null) {
        let control;
        if (options) {
            control = document.createElement('select');
            for (const [value, text] of options) control.append(new Option(text, value));
            control.value = state.session[key] ?? '';
        } else {
            control = input(type, `pref-${key}`, state.session[key]);
            if (type === 'number') control.step = 'any';
        }
        control.dataset.key = key;
        return control;
    }

    function scheduleOptions() {
        const options = [];
        for (let minutes = 0; minutes < 1440; minutes += 15) options.push([String(minutes), `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`]);
        return options;
    }

    function scheduleDayOptions() {
        return [['127', 'Every day'], ['62', 'Weekdays'], ['65', 'Weekends'], ['1', 'Sunday'], ['2', 'Monday'], ['4', 'Tuesday'], ['8', 'Wednesday'], ['16', 'Thursday'], ['32', 'Friday'], ['64', 'Saturday']];
    }

    function preferenceCheck(form, label, key) {
        const blank = document.createElement('span');
        const wrap = document.createElement('label');
        wrap.className = 'check-field';
        wrap.append(createPreferenceControl(key, 'checkbox'), document.createTextNode(label));
        form.append(blank, wrap);
    }

    function showPreferencesDialog() {
        const form = formGrid();
        form.append(sectionTitle('Torrents'));
        addField(form, 'Download to', createPreferenceControl('download_dir'));
        preferenceCheck(form, 'Use incomplete directory', 'incomplete_dir_enabled');
        addField(form, 'Incomplete directory', createPreferenceControl('incomplete_dir'));
        preferenceCheck(form, 'Start torrents when added', 'start_added_torrents');
        preferenceCheck(form, 'Rename incomplete files', 'rename_partial_files');
        preferenceCheck(form, 'Enable download queue', 'download_queue_enabled');
        addField(form, 'Download queue size', createPreferenceControl('download_queue_size', 'number'));
        preferenceCheck(form, 'Stop seeding at ratio', 'seed_ratio_limited');
        addField(form, 'Seed ratio limit', createPreferenceControl('seed_ratio_limit', 'number'));
        preferenceCheck(form, 'Stop seeding when idle', 'idle_seeding_limit_enabled');
        addField(form, 'Idle limit in minutes', createPreferenceControl('idle_seeding_limit', 'number'));
        form.append(sectionTitle('Speed'));
        preferenceCheck(form, 'Limit upload speed', 'speed_limit_up_enabled');
        addField(form, 'Upload limit in kB/s', createPreferenceControl('speed_limit_up', 'number'));
        preferenceCheck(form, 'Limit download speed', 'speed_limit_down_enabled');
        addField(form, 'Download limit in kB/s', createPreferenceControl('speed_limit_down', 'number'));
        addField(form, 'Alternative upload in kB/s', createPreferenceControl('alt_speed_up', 'number'));
        addField(form, 'Alternative download in kB/s', createPreferenceControl('alt_speed_down', 'number'));
        preferenceCheck(form, 'Schedule alternative limits', 'alt_speed_time_enabled');
        addField(form, 'Schedule begins', createPreferenceControl('alt_speed_time_begin', 'text', scheduleOptions()));
        addField(form, 'Schedule ends', createPreferenceControl('alt_speed_time_end', 'text', scheduleOptions()));
        addField(form, 'Schedule days', createPreferenceControl('alt_speed_time_day', 'text', scheduleDayOptions()));
        form.append(sectionTitle('Peers and network'));
        addField(form, 'Peers per torrent', createPreferenceControl('peer_limit_per_torrent', 'number'));
        addField(form, 'Peers overall', createPreferenceControl('peer_limit_global', 'number'));
        addField(form, 'Encryption', createPreferenceControl('encryption', 'text', [['preferred', 'Prefer encryption'], ['tolerated', 'Allow encryption'], ['required', 'Require encryption']]));
        preferenceCheck(form, 'Use PEX', 'pex_enabled');
        preferenceCheck(form, 'Use DHT', 'dht_enabled');
        preferenceCheck(form, 'Use LPD', 'lpd_enabled');
        preferenceCheck(form, 'Enable uTP', 'utp_enabled');
        preferenceCheck(form, 'Enable blocklist', 'blocklist_enabled');
        addField(form, 'Blocklist URL', createPreferenceControl('blocklist_url', 'url'));
        addField(form, 'Peer port', createPreferenceControl('peer_port', 'number'));
        preferenceCheck(form, 'Randomize port on launch', 'peer_port_random_on_start');
        preferenceCheck(form, 'Use router port forwarding', 'port_forwarding_enabled');
        const trackers = document.createElement('textarea');
        trackers.dataset.key = 'default_trackers';
        trackers.value = state.session.default_trackers || '';
        addField(form, 'Default public trackers', trackers);
        form.append(sectionTitle('Web interface'));
        const refresh = document.createElement('select');
        for (const value of [2, 5, 10, 30]) refresh.append(new Option(`${value} seconds`, value));
        refresh.value = state.refreshSeconds;
        addField(form, 'Refresh interval', refresh);
        const notifications = input('checkbox', 'web-notifications', state.notifications);
        const notifyWrap = document.createElement('label');
        notifyWrap.className = 'check-field';
        notifyWrap.append(notifications, document.createTextNode('Desktop completion notifications'));
        form.append(document.createElement('span'), notifyWrap);
        const contrast = input('checkbox', 'web-contrast', state.highContrast);
        const contrastWrap = document.createElement('label');
        contrastWrap.className = 'check-field';
        contrastWrap.append(contrast, document.createTextNode('High contrast interface'));
        form.append(document.createElement('span'), contrastWrap);
        const utilities = document.createElement('div');
        utilities.className = 'inline-actions full';
        const port = document.createElement('button');
        port.type = 'button';
        port.className = 'button';
        port.textContent = 'Test listening port';
        port.addEventListener('click', async () => {
            try {
                const [v4, v6] = await Promise.all([rpc.request('port_test', {ip_protocol: 'ipv4'}), rpc.request('port_test', {ip_protocol: 'ipv6'})]);
                toast('Port test complete', `IPv4: ${v4.port_is_open ? 'open' : 'closed'} · IPv6: ${v6.port_is_open ? 'open' : 'closed'}`);
            } catch (error) {
                reportError(error);
            }
        });
        const blocklist = document.createElement('button');
        blocklist.type = 'button';
        blocklist.className = 'button';
        blocklist.textContent = 'Update blocklist';
        blocklist.addEventListener('click', async () => {
            try {
                await rpc.request('blocklist_update');
                toast('Blocklist updated', '', 'success');
            } catch (error) {
                reportError(error);
            }
        });
        const protocol = document.createElement('button');
        protocol.type = 'button';
        protocol.className = 'button';
        protocol.textContent = 'Register magnet handler';
        protocol.disabled = !navigator.registerProtocolHandler;
        protocol.addEventListener('click', () => {
            const url = new URL(location.href);
            url.search = 'addtorrent=%s';
            navigator.registerProtocolHandler('magnet', url.toString(), 'Transmission Web');
        });
        utilities.append(port, blocklist, protocol);
        form.append(utilities);
        openModal({
            title: 'Preferences',
            subtitle: 'Transmission daemon and web interface settings.',
            body: form,
            wide: true,
            onConfirm: async () => {
                const params = {};
                for (const control of $$('[data-key]', form)) {
                    const value = control.type === 'checkbox' ? control.checked : control.type === 'number' ? Number(control.value) : control.value;
                    if (value !== state.session[control.dataset.key]) params[control.dataset.key] = value;
                }
                if (Object.keys(params).length) await rpc.request('session_set', params);
                state.refreshSeconds = Number(refresh.value);
                localStorage.setItem('tx-refresh', state.refreshSeconds);
                state.highContrast = contrast.checked;
                localStorage.setItem('tx-contrast', state.highContrast);
                document.body.classList.toggle('high-contrast', state.highContrast);
                state.notifications = notifications.checked;
                localStorage.setItem('tx-notifications', state.notifications);
                if (state.notifications && 'Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
                await loadSession();
                schedulePoll();
                toast('Preferences saved', '', 'success');
                return true;
            }
        });
    }

    function statisticValue(data, snakeKey, legacyKey) {
        return data?.[snakeKey] ?? data?.[legacyKey];
    }

    async function showStatisticsDialog() {
        try {
            const stats = await rpc.request('session_stats');
            const root = document.createElement('div');
            root.className = 'stats-grid';
            const card = (title, values) => {
                const article = document.createElement('article');
                article.className = 'stats-card';
                const heading = document.createElement('h3');
                heading.textContent = title;
                const dl = document.createElement('dl');
                for (const [key, value] of values) {
                    const dt = document.createElement('dt');
                    dt.textContent = key;
                    const dd = document.createElement('dd');
                    dd.textContent = value;
                    dl.append(dt, dd);
                }
                article.append(heading, dl);
                return article;
            };
            const values = data => {
                const uploaded = Number(statisticValue(data, 'uploaded_bytes', 'uploadedBytes')) || 0;
                const downloaded = Number(statisticValue(data, 'downloaded_bytes', 'downloadedBytes')) || 0;
                return [['Uploaded', formatBytes(uploaded)], ['Downloaded', formatBytes(downloaded)], ['Ratio', formatRatio(downloaded ? uploaded / downloaded : -1)], ['Files added', formatNumber(statisticValue(data, 'files_added', 'filesAdded'), 0)], ['Active time', formatDuration(statisticValue(data, 'seconds_active', 'secondsActive'))]];
            };
            root.append(card('Current session', values(stats.current_stats || {})), card('All time', values(stats.cumulative_stats || {})));
            openModal({title: 'Statistics', body: root, hideConfirm: true, cancelText: 'Close'});
        } catch (error) {
            reportError(error, 'Could not load statistics');
        }
    }

    function showShortcutsDialog() {
        const root = document.createElement('div');
        root.append(detailsSection('Keyboard shortcuts', [['Ctrl or Cmd + K', 'Focus search'], ['Ctrl or Cmd + A', 'Select visible torrents'], ['Escape', 'Close menu, details, or selection'], ['Enter on a torrent', 'Open details'], ['Space on a torrent', 'Toggle selection'], ['Delete', 'Remove selected torrents'], ['R', 'Start selected torrents'], ['P', 'Stop selected torrents'], ['V', 'Verify selected torrents']]));
        openModal({title: 'Keyboard shortcuts', body: root, hideConfirm: true, cancelText: 'Close'});
    }

    function showAboutDialog() {
        const root = document.createElement('div');
        root.append(detailsSection('Transmission Web', [['Interface', 'Standalone native HTML, CSS, and JavaScript'], ['RPC endpoint', RPC_URL], ['Daemon version', state.session.version || 'Unknown'], ['RPC version', String(state.session.rpc_version ?? 'Unknown')]]));
        openModal({
            title: 'About',
            subtitle: 'A dependency-free interface for Transmission.',
            body: root,
            hideConfirm: true,
            cancelText: 'Close'
        });
    }

    function applyTheme(preference = localStorage.getItem('tx-theme') || 'system') {
        const resolved = preference === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : preference;
        document.documentElement.dataset.theme = resolved;
        document.documentElement.dataset.themePreference = preference;
        $('#theme-use').setAttribute('href', resolved === 'dark' ? '#i-moon' : '#i-sun');
        $('meta[name="theme-color"]').content = resolved === 'dark' ? '#101318' : '#f4f6f9';
    }

    function cycleTheme() {
        const current = document.documentElement.dataset.theme;
        const next = current === 'dark' ? 'light' : 'dark';
        localStorage.setItem('tx-theme', next);
        applyTheme(next);
        toast('Theme changed', `${next[0].toUpperCase()}${next.slice(1)} theme`);
    }

    function bindEvents() {
        $$('.status-tabs button').forEach(button => button.addEventListener('click', () => {
            state.filter = button.dataset.filter;
            $$('.status-tabs button').forEach(item => {
                const active = item === button;
                item.classList.toggle('active', active);
                item.setAttribute('aria-pressed', String(active));
            });
            render();
        }));
        $('#privacy-filter').addEventListener('change', event => {
            state.privacy = event.target.value;
            render();
        });
        $('#tracker-filter').addEventListener('change', event => {
            state.tracker = event.target.value;
            render();
        });
        $('#sort-mode').value = state.sort;
        $('#sort-mode').addEventListener('change', event => {
            state.sort = event.target.value;
            localStorage.setItem('tx-sort', state.sort);
            render();
        });
        const updateSortDirection = () => {
            $('#sort-direction').classList.toggle('active', state.reverse);
            $('#sort-direction').setAttribute('aria-pressed', String(state.reverse));
            $('#sort-direction').textContent = state.reverse ? '↓' : '↑';
        };
        updateSortDirection();
        $('#sort-direction').addEventListener('click', () => {
            state.reverse = !state.reverse;
            localStorage.setItem('tx-sort-reverse', state.reverse);
            updateSortDirection();
            render();
        });
        $('#select-all-torrents').addEventListener('change', event => {
            const visibleIds = sortedVisibleTorrents().map(torrent => torrent.id);
            for (const id of visibleIds) event.target.checked ? state.selected.add(id) : state.selected.delete(id);
            render();
        });
        $('#torrent-search').addEventListener('input', event => {
            state.search = event.target.value.trim().toLowerCase();
            $('#clear-search').classList.toggle('visible', Boolean(event.target.value));
            render();
        });
        $('#clear-search').addEventListener('click', () => {
            $('#torrent-search').value = '';
            state.search = '';
            $('#clear-search').classList.remove('visible');
            render();
            $('#torrent-search').focus();
        });
        $('#add-button').addEventListener('click', () => showAddDialog());
        $('#empty-add').addEventListener('click', () => showAddDialog());
        $$('[data-action]').forEach(button => button.addEventListener('click', () => handleAction(button.dataset.action)));
        $('#refresh-button').addEventListener('click', () => refreshTorrents({quiet: false}));
        $('#alt-speed').addEventListener('click', async () => {
            try {
                const value = !state.session.alt_speed_enabled;
                await rpc.request('session_set', {alt_speed_enabled: value});
                state.session.alt_speed_enabled = value;
                $('#alt-speed').classList.toggle('active', value);
                $('#alt-speed').setAttribute('aria-pressed', String(value));
            } catch (error) {
                reportError(error);
            }
        });
        $('#theme-toggle').addEventListener('click', cycleTheme);
        $('#settings-button').addEventListener('click', showPreferencesDialog);
        $('#more-button').addEventListener('click', event => {
            event.stopPropagation();
            $('#popup-menu').hidden ? showMoreMenu() : closePopup();
        });
        $('#details-close').addEventListener('click', closeDetails);
        $('#details-backdrop').addEventListener('click', closeDetails);
        $$('.detail-tabs button').forEach(button => button.addEventListener('click', () => {
            state.detailTab = button.dataset.detailTab;
            renderDetails();
        }));
        document.addEventListener('click', event => {
            if (!event.target.closest('#popup-menu') && !event.target.closest('#more-button')) closePopup();
        });
        document.addEventListener('keydown', event => {
            const typing = /INPUT|TEXTAREA|SELECT/.test(event.target.tagName);
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
                event.preventDefault();
                $('#torrent-search').focus();
            } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a' && !typing) {
                event.preventDefault();
                handleAction('select-all');
            } else if (event.key === 'Escape' && !$('#popup-menu').hidden) closePopup();
            else if (event.key === 'Escape' && state.detailsOpen) closeDetails();
            else if (event.key === 'Escape' && state.selected.size) handleAction('deselect');
            else if (!typing && event.key === 'Delete') handleAction('remove');
            else if (!typing && event.key.toLowerCase() === 'r') handleAction('start');
            else if (!typing && event.key.toLowerCase() === 'p') handleAction('stop');
            else if (!typing && event.key.toLowerCase() === 'v') handleAction('verify');
        });
        const overlay = $('#drop-overlay');
        window.addEventListener('dragenter', event => {
            event.preventDefault();
            state.dragDepth++;
            overlay.hidden = false;
        });
        window.addEventListener('dragover', event => event.preventDefault());
        window.addEventListener('dragleave', event => {
            event.preventDefault();
            state.dragDepth = Math.max(0, state.dragDepth - 1);
            if (!state.dragDepth) overlay.hidden = true;
        });
        window.addEventListener('drop', event => {
            event.preventDefault();
            state.dragDepth = 0;
            overlay.hidden = true;
            const files = event.dataTransfer.files;
            const url = event.dataTransfer.getData('text/uri-list') || event.dataTransfer.getData('text/plain');
            showAddDialog(files, url);
        });
        matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
            if (document.documentElement.dataset.themePreference === 'system') applyTheme('system');
        });
    }

    async function initialize() {
        applyTheme();
        document.documentElement.style.removeProperty('--accent');
        localStorage.removeItem('tx-accent');
        localStorage.removeItem('tx-compact');
        document.body.classList.remove('compact');
        document.body.classList.toggle('high-contrast', state.highContrast);
        bindEvents();
        try {
            await loadSession();
            await refreshTorrents();
            const query = new URLSearchParams(location.search).get('addtorrent');
            if (query) showAddDialog(null, query);
        } catch (error) {
            reportError(error, 'Could not connect to Transmission');
            schedulePoll();
        }
    }

    document.addEventListener('DOMContentLoaded', initialize, {once: true});
})();
