/* Kundun Control Center — client logic.
 *
 * Vanilla ES module-free script (loaded with `defer`). Talks to the SAME-ORIGIN
 * local API with relative URLs only. Security/robustness rules honored here:
 *   - The API token is read from a header field, kept in localStorage, and sent
 *     as `Authorization: Bearer <token>` on every token-required call and as
 *     `?token=<token>` on the WebSocket. It is NEVER placed in the DOM or a log.
 *   - Every fetch is wrapped: failures render inline, never crash the page; a 401
 *     prompts the user to (re)paste the token.
 *   - All interpolated text goes through textContent / escapeHtml — no innerHTML
 *     with untrusted server data.
 *   - Public sections (health, sessions, metrics) auto-refresh; token-gated data
 *     (projects, logs) and the action POSTs require the token.
 */
(function () {
  'use strict';

  // ----- Constants -------------------------------------------------------

  var TOKEN_KEY = 'kundun_token';
  var AUTO_REFRESH_MS = 5000;
  var WS_BACKOFF_MIN_MS = 1000;
  var WS_BACKOFF_MAX_MS = 15000;
  var EVENT_FEED_MAX = 200;

  // ----- Small DOM + escaping helpers ------------------------------------

  function $(id) {
    return document.getElementById(id);
  }

  /** Escape text for safe insertion into an HTML string context. */
  function escapeHtml(value) {
    var s = value == null ? '' : String(value);
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** Create an element with optional class and text (text set via textContent). */
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  // ----- Formatting ------------------------------------------------------

  function fmtNumber(n) {
    if (n == null || isNaN(n)) return '—';
    return Number(n).toLocaleString();
  }

  function fmtMs(n) {
    if (n == null || isNaN(n)) return '—';
    return Math.round(Number(n)).toLocaleString() + ' ms';
  }

  function fmtBytes(n) {
    if (n == null || isNaN(n)) return '—';
    var units = ['B', 'KB', 'MB', 'GB', 'TB'];
    var v = Number(n);
    var i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    return (i === 0 ? v : v.toFixed(1)) + ' ' + units[i];
  }

  function fmtTime(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleString();
  }

  function fmtClock(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleTimeString();
  }

  /** Relative "x ago" using ISO timestamps; falls back to absolute on parse fail. */
  function fmtAgo(iso) {
    if (!iso) return '—';
    var then = new Date(iso).getTime();
    if (isNaN(then)) return String(iso);
    var secs = Math.max(0, Math.round((Date.now() - then) / 1000));
    if (secs < 60) return secs + 's ago';
    var mins = Math.round(secs / 60);
    if (mins < 60) return mins + 'm ago';
    var hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    var days = Math.round(hrs / 24);
    return days + 'd ago';
  }

  // ----- Token store -----------------------------------------------------

  var token = '';
  try {
    token = window.localStorage.getItem(TOKEN_KEY) || '';
  } catch (e) {
    token = '';
  }

  function setToken(value) {
    token = value || '';
    try {
      if (token) window.localStorage.setItem(TOKEN_KEY, token);
      else window.localStorage.removeItem(TOKEN_KEY);
    } catch (e) {
      /* storage may be unavailable; keep the in-memory token regardless */
    }
  }

  function hasToken() {
    return token.length > 0;
  }

  // ----- Toast -----------------------------------------------------------

  var toastTimer = null;
  function toast(message, isError) {
    var t = $('toast');
    t.textContent = message;
    t.className = 'toast' + (isError ? ' is-error' : '');
    t.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      t.hidden = true;
    }, 3500);
  }

  // ----- Wrapped fetch ---------------------------------------------------

  /**
   * Perform a same-origin API call. `opts.auth` adds the bearer header; `opts.body`
   * (an object) is JSON-encoded for POST. Resolves to the parsed JSON on 2xx.
   * Throws an Error with `.status` set on a non-2xx or transport failure so callers
   * can branch on 401. Never throws the token into a message.
   */
  function api(path, opts) {
    opts = opts || {};
    var method = opts.method || 'GET';
    var headers = {};
    var init = { method: method, headers: headers };

    if (opts.auth) {
      if (!hasToken()) {
        var noTok = new Error('A token is required for this action.');
        noTok.status = 401;
        return Promise.reject(noTok);
      }
      headers['Authorization'] = 'Bearer ' + token;
    }
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }

    return fetch(path, init).then(function (res) {
      var ctype = res.headers.get('content-type') || '';
      var parse = ctype.indexOf('application/json') !== -1 ? res.json() : res.text();
      return parse.then(
        function (data) {
          if (res.ok) return data;
          var err = new Error(extractError(data) || 'HTTP ' + res.status);
          err.status = res.status;
          err.body = data;
          throw err;
        },
        function () {
          if (res.ok) return null;
          var err2 = new Error('HTTP ' + res.status);
          err2.status = res.status;
          throw err2;
        },
      );
    });
  }

  /** Pull a human message out of the API's `{ error: { code, message } }` shape. */
  function extractError(data) {
    if (data && typeof data === 'object' && data.error && typeof data.error === 'object') {
      return data.error.message || data.error.code || '';
    }
    return '';
  }

  /** Render an inline error block into a container; prompts for token on 401. */
  function renderError(container, err) {
    clear(container);
    var box = el('div', 'inline-error');
    if (err && err.status === 401) {
      box.textContent = 'Unauthorized — paste a valid API token in the header to continue.';
      flashTokenField();
    } else {
      box.textContent = err && err.message ? err.message : 'Request failed.';
    }
    container.appendChild(box);
  }

  function flashTokenField() {
    var input = $('token-input');
    input.focus();
    input.style.borderColor = 'var(--bad)';
    setTimeout(function () {
      input.style.borderColor = '';
    }, 1200);
  }

  // ----- Renderers: cards / pills ---------------------------------------

  function card(label, value, opts) {
    opts = opts || {};
    var c = el('div', 'card' + (opts.span2 ? ' span-2' : ''));
    c.appendChild(el('div', 'card-label', label));
    var v = el('div', 'card-value' + (opts.small ? ' small' : ''));
    if (opts.pill) {
      v.appendChild(statusPill(value));
    } else {
      v.textContent = value == null ? '—' : String(value);
    }
    c.appendChild(v);
    if (opts.sub != null) c.appendChild(el('div', 'card-sub', opts.sub));
    return c;
  }

  /** A colored status pill. `status` is a known state string; unknowns get a
   *  neutral pill. The class is derived from a strict allowlist, never the raw
   *  value, so a hostile status string cannot inject a class. */
  var KNOWN_STATES = {
    ok: 'pill-ok',
    active: 'pill-active',
    idle: 'pill-idle',
    degraded: 'pill-degraded',
    down: 'pill-down',
    crashed: 'pill-crashed',
    disconnected: 'pill-disconnected',
    closed: 'pill-closed',
    unknown: 'pill-unknown',
  };

  function statusPill(status) {
    var key = String(status == null ? 'unknown' : status).toLowerCase();
    var cls = KNOWN_STATES[key] || 'pill-unknown';
    var p = el('span', 'pill ' + cls, status == null ? 'unknown' : String(status));
    return p;
  }

  // ----- Section: Dashboard ---------------------------------------------

  var lastHealth = null;
  var lastMetrics = null;
  var lastSessions = null;
  var lastProject = null;

  function renderDashboard() {
    var host = $('dashboard-cards');
    clear(host);

    var m = lastMetrics && lastMetrics.latest;
    var h = lastHealth;

    var projectName = lastProject ? lastProject.projectName : null;
    var projectRoot = lastProject ? lastProject.projectRoot : null;

    host.appendChild(
      card('Project', projectName || (hasToken() ? '—' : 'unlock to view'), {
        small: true,
        sub: projectRoot || (hasToken() ? '' : 'token required for path'),
        span2: true,
      }),
    );

    var overall = h ? overallStatus(h.components) : 'unknown';
    host.appendChild(card('Status', overall, { pill: true }));
    host.appendChild(
      card('Active sessions', lastSessions ? fmtNumber(lastSessions.activeCount) : '—'),
    );
    host.appendChild(card('Indexed files', m ? fmtNumber(m.indexed_files) : '—'));
    host.appendChild(card('Indexed chunks', m ? fmtNumber(m.indexed_chunks) : '—'));
    host.appendChild(card('Memories', m ? fmtNumber(m.memory_count) : '—'));
    host.appendChild(card('Tasks', m ? fmtNumber(m.task_count) : '—'));
    host.appendChild(
      card('Errors (24h)', h ? fmtNumber(h.errorsLast24h) : '—', {
        sub: m && m.errors_last_24h != null ? 'snapshot: ' + fmtNumber(m.errors_last_24h) : '',
      }),
    );
    host.appendChild(
      card('Last scan', m ? fmtMs(m.scan_duration_ms) : '—', {
        small: true,
        sub: m ? 'at ' + fmtAgo(m.created_at) : '',
      }),
    );
    host.appendChild(card('Last cleanup', m ? fmtMs(m.cleanup_duration_ms) : '—', { small: true }));
    host.appendChild(card('Search mode', h ? h.searchMode : '—', { small: true }));
    host.appendChild(card('Schema', h ? 'v' + h.schemaVersion : '—', { small: true }));
  }

  /** Reduce component statuses to a single worst-of overall state. */
  function overallStatus(components) {
    if (!components) return 'unknown';
    var worst = 'ok';
    var rank = { ok: 0, unknown: 1, degraded: 2, down: 3 };
    for (var key in components) {
      if (!Object.prototype.hasOwnProperty.call(components, key)) continue;
      var s = components[key];
      if ((rank[s] || 0) > (rank[worst] || 0)) worst = s;
    }
    return worst;
  }

  // ----- Section: Sessions ----------------------------------------------

  function renderSessions() {
    var host = $('sessions-table');
    clear(host);
    var data = lastSessions;
    if (!data) {
      host.appendChild(emptyState('No session data yet.'));
      return;
    }
    $('sessions-summary').textContent =
      fmtNumber(data.activeCount) + ' active · ' + fmtNumber(data.sessions.length) + ' recent';

    if (!data.sessions.length) {
      host.appendChild(emptyState('No sessions recorded.'));
      return;
    }

    var cols = ['Client', 'Status', 'Started', 'Last activity', 'Tools', 'Errors', 'Operation'];
    var table = buildTable(cols, data.sessions, function (row, s) {
      appendCell(row, clientLabel(s), 'mono-cell');
      appendPillCell(row, s.status);
      appendCell(row, fmtAgo(s.started_at), null, fmtTime(s.started_at));
      appendCell(row, fmtAgo(s.last_activity_at), null, fmtTime(s.last_activity_at));
      appendCell(row, fmtNumber(s.tools_called));
      appendCell(row, fmtNumber(s.errors_count));
      appendCell(row, s.current_operation || '—', 'mono-cell');
    });
    host.appendChild(table);
  }

  function clientLabel(s) {
    var name = s.client_name || 'unknown';
    if (s.client_version) name += ' ' + s.client_version;
    return name;
  }

  // ----- Section: Health -------------------------------------------------

  function renderHealth() {
    var headline = $('health-headline');
    var comps = $('health-components');
    clear(headline);
    clear(comps);

    var h = lastHealth;
    if (!h) {
      headline.appendChild(emptyState('No health data yet.'));
      return;
    }
    $('health-generated').textContent = 'generated ' + fmtAgo(h.generatedAt);

    headline.appendChild(card('Overall', overallStatus(h.components), { pill: true }));
    headline.appendChild(card('Errors (24h)', fmtNumber(h.errorsLast24h)));
    headline.appendChild(
      card('Avg tool latency', h.avgToolLatencyMs == null ? '—' : fmtMs(h.avgToolLatencyMs), {
        small: true,
      }),
    );
    headline.appendChild(card('Search mode', h.searchMode, { small: true }));
    headline.appendChild(card('Schema version', 'v' + h.schemaVersion, { small: true }));

    var names = Object.keys(h.components || {}).sort();
    if (!names.length) {
      comps.appendChild(emptyState('No components reported.'));
      return;
    }
    names.forEach(function (name) {
      var item = el('div', 'component');
      item.appendChild(el('span', 'component-name', name));
      item.appendChild(statusPill(h.components[name]));
      comps.appendChild(item);
    });
  }

  // ----- Section: Metrics ------------------------------------------------

  function renderMetrics() {
    var host = $('metrics-latest');
    clear(host);
    var data = lastMetrics;
    if (!data || !data.latest) {
      host.appendChild(emptyState('No metrics snapshots recorded yet.'));
      clear($('metrics-spark'));
      clear($('metrics-table'));
      $('metrics-generated').textContent = '';
      return;
    }
    var m = data.latest;
    $('metrics-generated').textContent = 'latest ' + fmtAgo(m.created_at);

    host.appendChild(card('Active sessions', fmtNumber(m.active_sessions)));
    host.appendChild(card('Indexed files', fmtNumber(m.indexed_files)));
    host.appendChild(card('Indexed chunks', fmtNumber(m.indexed_chunks)));
    host.appendChild(card('Memories', fmtNumber(m.memory_count)));
    host.appendChild(card('Tasks', fmtNumber(m.task_count)));
    host.appendChild(card('Diagnostics', fmtNumber(m.diagnostics_count)));
    host.appendChild(card('DB size', fmtBytes(m.db_size_bytes), { small: true }));
    host.appendChild(card('Errors (24h)', fmtNumber(m.errors_last_24h)));

    renderSparkline(data.recent);
    renderMetricsTable(data.recent);
  }

  /** Draw a tiny SVG sparkline of indexed_chunks across recent snapshots. The SVG
   *  is built from numeric, bounded values only (no string interpolation of data
   *  into markup beyond computed coordinates). */
  function renderSparkline(recent) {
    var wrap = $('metrics-spark');
    clear(wrap);
    var rows = (recent || []).slice().reverse(); // oldest -> newest left-to-right
    if (rows.length < 2) {
      wrap.appendChild(el('div', 'spark-legend', 'Not enough snapshots for a trend yet.'));
      return;
    }
    var values = rows.map(function (r) {
      return Number(r.indexed_chunks) || 0;
    });
    var max = Math.max.apply(null, values);
    var min = Math.min.apply(null, values);
    var span = max - min || 1;
    var w = 600;
    var hgt = 60;
    var pad = 4;
    var step = (w - pad * 2) / (values.length - 1);

    var points = values
      .map(function (v, i) {
        var x = pad + i * step;
        var y = pad + (hgt - pad * 2) * (1 - (v - min) / span);
        return x.toFixed(1) + ',' + y.toFixed(1);
      })
      .join(' ');

    var svgNs = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(svgNs, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + w + ' ' + hgt);
    svg.setAttribute('preserveAspectRatio', 'none');
    var poly = document.createElementNS(svgNs, 'polyline');
    poly.setAttribute('points', points);
    poly.setAttribute('fill', 'none');
    poly.setAttribute('stroke', 'var(--accent)');
    poly.setAttribute('stroke-width', '2');
    poly.setAttribute('stroke-linejoin', 'round');
    poly.setAttribute('stroke-linecap', 'round');
    svg.appendChild(poly);
    wrap.appendChild(svg);

    wrap.appendChild(
      el(
        'div',
        'spark-legend',
        'indexed chunks · ' +
          values.length +
          ' snapshots · min ' +
          fmtNumber(min) +
          ' / max ' +
          fmtNumber(max),
      ),
    );
  }

  function renderMetricsTable(recent) {
    var host = $('metrics-table');
    clear(host);
    var rows = recent || [];
    if (!rows.length) {
      host.appendChild(emptyState('No recent snapshots.'));
      return;
    }
    var cols = ['When', 'Sessions', 'Files', 'Chunks', 'Memories', 'Tasks', 'DB size', 'Errors24h'];
    var table = buildTable(cols, rows, function (row, r) {
      appendCell(row, fmtAgo(r.created_at), null, fmtTime(r.created_at));
      appendCell(row, fmtNumber(r.active_sessions));
      appendCell(row, fmtNumber(r.indexed_files));
      appendCell(row, fmtNumber(r.indexed_chunks));
      appendCell(row, fmtNumber(r.memory_count));
      appendCell(row, fmtNumber(r.task_count));
      appendCell(row, fmtBytes(r.db_size_bytes), 'mono-cell');
      appendCell(row, fmtNumber(r.errors_last_24h));
    });
    host.appendChild(table);
  }

  // ----- Section: Logs ---------------------------------------------------

  function loadLogs() {
    var box = $('logs-box');
    if (!hasToken()) {
      box.textContent = '';
      box.appendChild(el('span', null, 'Paste the API token in the header to view daemon logs.'));
      $('logs-meta').textContent = 'token required';
      return;
    }
    api('/logs', { auth: true }).then(
      function (data) {
        $('logs-meta').textContent =
          (data.latest || 'no file') + ' · ' + (data.tail ? data.tail.length : 0) + ' lines';
        box.textContent = data.tail && data.tail.length ? data.tail.join('\n') : '(log file empty)';
        box.scrollTop = box.scrollHeight;
      },
      function (err) {
        renderError(box.parentElement || box, err);
        $('logs-meta').textContent = 'error';
      },
    );
  }

  // ----- Section: Actions ------------------------------------------------

  function runAction(action) {
    var resultBox = $('action-result');
    var config = {
      scan: { path: '/scan', body: {} },
      cleanup: { path: '/cleanup', body: { dryRun: true } },
      diagnostics: { path: '/diagnostics', body: {} },
    }[action];
    if (!config) return;

    if (!hasToken()) {
      resultBox.textContent = 'A token is required to run this action. Paste it in the header.';
      flashTokenField();
      return;
    }

    setActionsDisabled(true);
    resultBox.textContent = 'Running ' + action + '…';
    api(config.path, { method: 'POST', body: config.body, auth: true })
      .then(
        function (data) {
          resultBox.textContent = JSON.stringify(data, null, 2);
          toast(action + ' complete');
          // Refresh dependent sections immediately.
          refreshPublic();
        },
        function (err) {
          if (err && err.status === 409) {
            resultBox.textContent =
              'Another operation is already running. Try again shortly.\n\n' +
              JSON.stringify(err.body || {}, null, 2);
          } else if (err && err.status === 401) {
            resultBox.textContent = 'Unauthorized — the token was rejected.';
            flashTokenField();
          } else {
            resultBox.textContent =
              'Error: ' + (err && err.message ? err.message : 'request failed');
          }
        },
      )
      ['finally'](function () {
        setActionsDisabled(false);
      });
  }

  function setActionsDisabled(disabled) {
    var buttons = document.querySelectorAll('#action-buttons .btn-action');
    for (var i = 0; i < buttons.length; i++) buttons[i].disabled = disabled;
  }

  // ----- Table helpers ---------------------------------------------------

  function buildTable(columns, rows, fillRow) {
    var table = document.createElement('table');
    var thead = document.createElement('thead');
    var htr = document.createElement('tr');
    columns.forEach(function (c) {
      htr.appendChild(el('th', null, c));
    });
    thead.appendChild(htr);
    table.appendChild(thead);

    var tbody = document.createElement('tbody');
    rows.forEach(function (r) {
      var tr = document.createElement('tr');
      fillRow(tr, r);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    return table;
  }

  function appendCell(row, text, className, title) {
    var td = el('td', className || null, text == null ? '—' : String(text));
    if (title) td.title = title;
    row.appendChild(td);
  }

  function appendPillCell(row, status) {
    var td = document.createElement('td');
    td.appendChild(statusPill(status));
    row.appendChild(td);
  }

  function emptyState(message) {
    return el('div', 'empty', message);
  }

  // ----- Public data refresh --------------------------------------------

  var activeTab = 'dashboard';

  function refreshPublic() {
    // Health, sessions, metrics are public; projects needs the token.
    api('/health').then(
      function (d) {
        lastHealth = d;
        if (activeTab === 'dashboard') renderDashboard();
        if (activeTab === 'health') renderHealth();
      },
      function () {
        /* transient; keep last good data */
      },
    );
    api('/sessions').then(
      function (d) {
        lastSessions = d;
        if (activeTab === 'dashboard') renderDashboard();
        if (activeTab === 'sessions') renderSessions();
      },
      function () {},
    );
    api('/metrics').then(
      function (d) {
        lastMetrics = d;
        if (activeTab === 'dashboard') renderDashboard();
        if (activeTab === 'metrics') renderMetrics();
      },
      function () {},
    );
    if (hasToken()) {
      api('/projects', { auth: true }).then(
        function (list) {
          lastProject = Array.isArray(list) && list.length ? list[0] : null;
          if (activeTab === 'dashboard') renderDashboard();
        },
        function () {
          /* token may be wrong; the dashboard still shows public data */
        },
      );
    }
  }

  // ----- Tabs ------------------------------------------------------------

  function activateTab(name) {
    activeTab = name;
    var tabs = document.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('is-active', tabs[i].getAttribute('data-tab') === name);
    }
    var panels = document.querySelectorAll('.panel');
    for (var j = 0; j < panels.length; j++) {
      panels[j].classList.toggle('is-active', panels[j].id === 'panel-' + name);
    }
    // Render the freshly shown panel from cached data, and pull fresh on demand.
    if (name === 'dashboard') renderDashboard();
    else if (name === 'sessions') renderSessions();
    else if (name === 'health') renderHealth();
    else if (name === 'metrics') renderMetrics();
    else if (name === 'logs') loadLogs();
  }

  // ----- WebSocket live events ------------------------------------------

  var ws = null;
  var wsBackoff = WS_BACKOFF_MIN_MS;
  var wsManualClose = false;

  function wsUrl() {
    var proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    var base = proto + '//' + window.location.host + '/events';
    return hasToken() ? base + '?token=' + encodeURIComponent(token) : base;
  }

  function setWsIndicator(state) {
    var dot = $('ws-dot');
    var label = $('ws-label');
    dot.className = 'ws-dot ' + (state === 'on' ? 'is-on' : 'is-off');
    label.textContent = state === 'on' ? 'live' : 'offline';
  }

  function connectWs() {
    if (!hasToken()) {
      // The WS upgrade requires the token; without it, stay offline and hint.
      setWsIndicator('off');
      return;
    }
    wsManualClose = false;
    try {
      ws = new WebSocket(wsUrl());
    } catch (e) {
      scheduleWsReconnect();
      return;
    }

    ws.onopen = function () {
      wsBackoff = WS_BACKOFF_MIN_MS;
      setWsIndicator('on');
    };
    ws.onmessage = function (evt) {
      var payload = null;
      try {
        payload = JSON.parse(evt.data);
      } catch (e) {
        return;
      }
      handleEvent(payload);
    };
    ws.onclose = function () {
      setWsIndicator('off');
      if (!wsManualClose) scheduleWsReconnect();
    };
    ws.onerror = function () {
      // onclose will follow and handle the reconnect; just flip the indicator.
      setWsIndicator('off');
    };
  }

  function scheduleWsReconnect() {
    var delay = wsBackoff;
    wsBackoff = Math.min(wsBackoff * 2, WS_BACKOFF_MAX_MS);
    setTimeout(function () {
      if (!wsManualClose) connectWs();
    }, delay);
  }

  function reconnectWs() {
    wsManualClose = true;
    if (ws) {
      try {
        ws.close();
      } catch (e) {
        /* ignore */
      }
      ws = null;
    }
    wsBackoff = WS_BACKOFF_MIN_MS;
    connectWs();
  }

  // ----- Event handling --------------------------------------------------

  function handleEvent(payload) {
    if (!payload || typeof payload.type !== 'string') return;
    appendEvent(payload);

    var type = payload.type;
    // Refresh the relevant cached data on meaningful transitions.
    if (
      type === 'scan.completed' ||
      type === 'cleanup.completed' ||
      type === 'diagnostics.completed' ||
      type.indexOf('session.') === 0 ||
      type.indexOf('health.') === 0
    ) {
      refreshPublic();
    }
  }

  function eventSeverityClass(type) {
    if (type.indexOf('.failed') !== -1 || type === 'health.error') return 'ev-error';
    if (type.indexOf('health.warning') !== -1) return 'ev-warn';
    if (type.indexOf('.completed') !== -1 || type === 'session.ended') return 'ev-done';
    return '';
  }

  function appendEvent(payload) {
    var feed = $('event-feed');
    var li = document.createElement('li');
    var sev = eventSeverityClass(payload.type);
    if (sev) li.className = sev;

    li.appendChild(el('span', 'event-type', payload.type));

    var dataText = '';
    if (payload.data && typeof payload.data === 'object') {
      try {
        var keys = Object.keys(payload.data);
        if (keys.length) dataText = compactData(payload.data);
      } catch (e) {
        dataText = '';
      }
    }
    if (dataText) li.appendChild(el('span', 'event-data', dataText));

    li.appendChild(el('span', 'event-time', fmtClock(payload.at)));

    // Newest on top.
    if (feed.firstChild) feed.insertBefore(li, feed.firstChild);
    else feed.appendChild(li);

    // Bound the feed length.
    while (feed.childNodes.length > EVENT_FEED_MAX) {
      feed.removeChild(feed.lastChild);
    }
  }

  /** Compact a small data object into a one-line, length-bounded preview. */
  function compactData(data) {
    var parts = [];
    var keys = Object.keys(data);
    for (var i = 0; i < keys.length && i < 4; i++) {
      var k = keys[i];
      var v = data[k];
      if (v != null && typeof v === 'object') v = Array.isArray(v) ? '[' + v.length + ']' : '{…}';
      parts.push(k + '=' + String(v));
    }
    var s = parts.join(' ');
    return s.length > 80 ? s.slice(0, 77) + '…' : s;
  }

  // ----- Auto-refresh timer ---------------------------------------------

  var autoTimer = null;
  function startAuto() {
    stopAuto();
    autoTimer = setInterval(function () {
      refreshPublic();
      if (activeTab === 'logs') loadLogs();
    }, AUTO_REFRESH_MS);
  }
  function stopAuto() {
    if (autoTimer) {
      clearInterval(autoTimer);
      autoTimer = null;
    }
  }

  // ----- Wiring ----------------------------------------------------------

  function init() {
    // Server URL display (same-origin).
    $('server-url').textContent = window.location.host;

    // Token field: prefill nothing (do not echo a stored token into the DOM as
    // value? We DO put it in the password field so the user can see it's set —
    // but we keep it masked. This is the user's own token on their own machine.)
    if (hasToken()) $('token-input').value = token;

    // Tabs.
    var tabs = document.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener('click', function () {
        activateTab(this.getAttribute('data-tab'));
      });
    }

    // Token save / clear.
    $('token-save').addEventListener('click', function () {
      var val = $('token-input').value.trim();
      setToken(val);
      if (hasToken()) {
        toast('Token saved');
        refreshPublic();
        reconnectWs();
        if (activeTab === 'logs') loadLogs();
      } else {
        toast('Token is empty', true);
      }
    });
    $('token-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') $('token-save').click();
    });
    $('token-clear').addEventListener('click', function () {
      setToken('');
      $('token-input').value = '';
      toast('Token cleared');
      lastProject = null;
      renderDashboard();
      if (activeTab === 'logs') loadLogs();
      reconnectWs();
    });

    // Action buttons.
    var actionButtons = document.querySelectorAll('#action-buttons .btn-action');
    for (var a = 0; a < actionButtons.length; a++) {
      actionButtons[a].addEventListener('click', function () {
        runAction(this.getAttribute('data-action'));
      });
    }

    // Auto-refresh toggle.
    $('auto-refresh').addEventListener('change', function () {
      if (this.checked) startAuto();
      else stopAuto();
    });

    // Clear events.
    $('events-clear').addEventListener('click', function () {
      clear($('event-feed'));
    });

    // First paint + connections.
    renderDashboard();
    refreshPublic();
    startAuto();
    connectWs();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
