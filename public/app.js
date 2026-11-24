'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const canvas = $('world');
  const ctx = canvas.getContext('2d');
  const wrap = $('canvasWrap');

  const COLORS = ['#60a5fa', '#f472b6', '#a78bfa', '#2dd4bf', '#fb923c', '#e5e7eb', '#facc15', '#4ade80'];
  const HEADINGS = [0, Math.PI, Math.PI / 2, -Math.PI / 2]; // E, W, S, N
  const ALERT_COLOR = ['#34d399', '#fbbf24', '#f43f5e'];

  let world = null;
  let prev = null, cur = null, curAt = 0;
  let selected = null;
  let ws = null;
  let paused = false;
  let crashFx = []; // {x,y,t}
  const ui = { showLinks: false, showPulses: true };
  let scale = 1, dpr = 1, size = 600;

  // ------------------------------------------------------------ networking
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    setConn('wait', 'Connecting…');
    ws.onopen = () => {
      setConn('ok', 'Live · 20 Hz');
      $('overlay').classList.add('hidden');
      sendConfig();
      send({ type: 'links', on: ui.showLinks });
      if (selected) send({ type: 'select', id: selected });
    };
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === 'world') { world = m.world; resize(); return; }
      if (m.type === 'state') onState(m);
    };
    ws.onclose = () => {
      setConn('bad', 'Disconnected – retrying…');
      $('overlay').textContent = 'Connection lost – reconnecting…';
      $('overlay').classList.remove('hidden');
      setTimeout(connect, 1500);
    };
  }
  function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
  function setConn(state, text) {
    $('conn').className = 'conn ' + (state === 'ok' ? 'ok' : state === 'bad' ? 'bad' : '');
    $('connText').textContent = text;
  }

  function currentConfig() {
    return {
      v2v: $('modeV2V').classList.contains('active'),
      range: +$('range').value,
      loss: +$('loss').value / 100,
      spawnRate: +$('rate').value,
      speed: +document.querySelector('#speed .active').dataset.v,
      paused,
    };
  }
  function sendConfig() { send({ type: 'config', config: currentConfig() }); }

  // ------------------------------------------------------------ state handling
  function onState(m) {
    prev = cur;
    m.map = new Map(m.v.map((a) => [a[0], a]));
    cur = m;
    curAt = performance.now();
    if (prev) {
      for (const a of m.v) {
        const p = prev.map.get(a[0]);
        if (a[7] && p && !p[7]) crashFx.push({ x: a[1], y: a[2], t: performance.now() });
      }
    }
    if (selected && !m.map.has(selected)) { selected = null; send({ type: 'select', id: null }); }
    updateStats(m);
    updateBanner(m);
    updateObu(m.sel);
    appendLog(m.events);
  }

  function updateStats(m) {
    const s = m.stats;
    $('sVeh').textContent = s.vehicles;
    $('sMsg').textContent = m.cfg.v2v ? s.msgsPerSec : '—';
    $('sPdr').textContent = m.cfg.v2v ? s.pdr + '%' : '—';
    $('sLat').textContent = m.cfg.v2v ? s.latency + ' ms' : '—';
    $('sWarn').textContent = s.warnings;
    $('sCol').textContent = s.collisions;
    $('sPass').textContent = s.passed;
    $('sTime').textContent = Math.floor(m.t) + ' s';
  }

  function updateBanner(m) {
    const b = $('banner');
    let lvl = 0, n2 = 0, n1 = 0, crashed = 0;
    for (const a of m.v) {
      if (a[7]) crashed++;
      else if (a[5] === 2) n2++;
      else if (a[5] === 1) n1++;
      lvl = Math.max(lvl, a[5]);
    }
    if (crashed) { b.className = 'banner danger'; b.textContent = `💥 Collision on the road (${crashed} vehicles)`; }
    else if (n2) { b.className = 'banner danger'; b.textContent = m.cfg.v2v ? `⚠ ${n2} vehicle(s) braking on V2V collision warning` : `⚠ ${n2} vehicle(s) braking – late sensor detection`; }
    else if (n1) { b.className = 'banner caution'; b.textContent = `${n1} vehicle(s) received a caution warning`; }
    else { b.className = 'banner'; b.textContent = m.cfg.v2v ? '✓ All clear – V2V active' : 'All clear – sensors only'; }
  }

  const ALERT_TEXT = {
    FCW: 'Forward Collision Warning', ICW: 'Intersection Collision Warning', EEBL: 'Emergency Brake Light ahead',
    HAZARD: 'Hazard ahead', 'E-BRAKE': 'Emergency braking', CRASHED: 'Vehicle crashed',
  };
  function updateObu(sel) {
    const box = $('obu');
    if (!sel) {
      $('obuId').textContent = '— none selected';
      box.className = 'obu empty';
      box.innerHTML = 'Click any vehicle on the map to see what its OBU knows: speed, received BSMs, time-to-collision and the active warning.';
      return;
    }
    $('obuId').textContent = `— V${sel.id} (${sel.approach})`;
    box.className = 'obu';
    const label = sel.alertType ? (ALERT_TEXT[sel.alertType] || sel.alertType) : 'No threat detected';
    const lvl = sel.alertType === 'CRASHED' ? 2 : sel.alert;
    const rows = sel.nbrs.map((n) => `<tr><td>V${n.id}</td><td>${n.dist} m</td><td>${n.src === 'SENSOR' ? '—' : n.age + ' ms'}</td><td class="src-${n.src}">${n.src}</td></tr>`).join('');
    box.innerHTML = `
      <span class="alert-badge l${lvl}">${lvl === 2 ? '⚠ ' : ''}${label}</span>
      <div class="kv">
        <div><small>Speed</small><b>${sel.speed} km/h</b></div>
        <div><small>Accel</small><b>${sel.accel} m/s²</b></div>
        <div><small>TTC</small><b>${sel.ttc != null ? sel.ttc + ' s' : '∞'}</b></div>
        <div><small>Decision</small><b>${sel.role}</b></div>
        <div><small>BSM sent</small><b>${sel.tx}</b></div>
        <div><small>BSM recv</small><b>${sel.rx}</b></div>
      </div>
      <table class="nbrs"><thead><tr><th>Neighbour</th><th>Dist</th><th>Msg age</th><th>Source</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4" style="color:var(--muted)">No neighbours perceived</td></tr>'}</tbody></table>`;
  }

  function appendLog(events) {
    if (!events || !events.length) return;
    const log = $('log');
    for (const e of events) {
      const li = document.createElement('li');
      li.className = e.kind;
      li.innerHTML = `<span class="t">${e.t.toFixed(1)}s</span>`;
      li.appendChild(document.createTextNode(e.msg));
      log.prepend(li);
    }
    while (log.children.length > 80) log.lastChild.remove();
  }

  // ------------------------------------------------------------ rendering
  function resize() {
    const r = wrap.getBoundingClientRect();
    size = Math.min(r.width, r.height);
    dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
    if (world) scale = size / world.WORLD;
  }
  window.addEventListener('resize', resize);

  function lerpVehicles() {
    if (!cur) return [];
    const alpha = Math.min(1, (performance.now() - curAt) / 50);
    return cur.v.map((a) => {
      const p = prev && prev.map.get(a[0]);
      const x = p ? p[1] + (a[1] - p[1]) * alpha : a[1];
      const y = p ? p[2] + (a[2] - p[2]) * alpha : a[2];
      return { id: a[0], x, y, ap: a[3], v: a[4], alert: a[5], braking: a[6], crashed: a[7], color: a[8], nbrs: a[9], type: a[10] };
    });
  }

  function drawWorld() {
    const W = world.WORLD, C = world.C, L = world.LANE_W;
    // ground
    ctx.fillStyle = '#16241b';
    ctx.fillRect(0, 0, W, W);
    // footpaths
    ctx.fillStyle = '#3a4350';
    ctx.fillRect(0, C - L - 2, W, 2 * L + 4);
    ctx.fillRect(C - L - 2, 0, 2 * L + 4, W);
    // roads
    ctx.fillStyle = '#262c34';
    ctx.fillRect(0, C - L, W, 2 * L);
    ctx.fillRect(C - L, 0, 2 * L, W);
    // buildings
    for (const b of world.BUILDINGS) {
      ctx.fillStyle = '#2a3444';
      ctx.fillRect(b.x, b.y, b.w, b.h);
      ctx.fillStyle = '#323e51';
      const pad = 5;
      for (let gx = b.x + pad; gx < b.x + b.w - pad; gx += 14) {
        for (let gy = b.y + pad; gy < b.y + b.h - pad; gy += 14) ctx.fillRect(gx, gy, 9, 9);
      }
    }
    // centre dashed line
    ctx.strokeStyle = '#d8b13a';
    ctx.lineWidth = 0.35;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(0, C); ctx.lineTo(C - L - 1, C);
    ctx.moveTo(C + L + 1, C); ctx.lineTo(W, C);
    ctx.moveTo(C, 0); ctx.lineTo(C, C - L - 1);
    ctx.moveTo(C, C + L + 1); ctx.lineTo(C, W);
    ctx.stroke();
    ctx.setLineDash([]);
    // stop lines (left-hand traffic)
    ctx.strokeStyle = '#e5e7eb';
    ctx.lineWidth = 0.5;
    const sl = world.BOX + 1;
    ctx.beginPath();
    ctx.moveTo(C - sl, C - L); ctx.lineTo(C - sl, C);       // eastbound
    ctx.moveTo(C + sl, C); ctx.lineTo(C + sl, C + L);       // westbound
    ctx.moveTo(C, C - sl); ctx.lineTo(C + L, C - sl);       // southbound
    ctx.moveTo(C - L, C + sl); ctx.lineTo(C, C + sl);       // northbound
    ctx.stroke();
    // blind-corner tags
    ctx.fillStyle = 'rgba(230,237,245,.35)';
    ctx.font = '4px Inter, sans-serif';
    ctx.textAlign = 'center';
    for (const b of world.BUILDINGS) ctx.fillText('BLIND CORNER', b.x + b.w / 2, b.y + b.h / 2);
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawVehicle(v, now) {
    const len = 4.6, wid = 1.9;
    ctx.save();
    ctx.translate(v.x, v.y);
    ctx.rotate(HEADINGS[v.ap]);
    if (!v.crashed && v.alert) {
      ctx.shadowColor = ALERT_COLOR[v.alert];
      ctx.shadowBlur = 14 * scale * dpr / 3;
      ctx.fillStyle = ALERT_COLOR[v.alert] + (v.alert === 2 ? '66' : '44');
      roundRect(-len / 2 - 1, -wid / 2 - 1, len + 2, wid + 2, 1.2);
      ctx.fill();
      ctx.shadowBlur = 0;
    }
    ctx.fillStyle = v.crashed ? '#6b7280' : COLORS[v.color];
    roundRect(-len / 2, -wid / 2, len, wid, 0.6);
    ctx.fill();
    // windshield + roof
    ctx.fillStyle = 'rgba(10,16,24,.75)';
    ctx.fillRect(len / 2 - 1.6, -wid / 2 + 0.25, 0.8, wid - 0.5);
    ctx.fillStyle = 'rgba(255,255,255,.15)';
    ctx.fillRect(-len / 2 + 1, -wid / 2 + 0.3, 2, wid - 0.6);
    // lights
    ctx.fillStyle = '#fff7c2';
    ctx.fillRect(len / 2 - 0.25, -wid / 2 + 0.15, 0.25, 0.45);
    ctx.fillRect(len / 2 - 0.25, wid / 2 - 0.6, 0.25, 0.45);
    ctx.fillStyle = v.braking ? '#ff2d2d' : '#7a1d1d';
    if (v.braking) { ctx.shadowColor = '#ff2d2d'; ctx.shadowBlur = 10 * dpr; }
    ctx.fillRect(-len / 2, -wid / 2 + 0.1, 0.35, 0.55);
    ctx.fillRect(-len / 2, wid / 2 - 0.65, 0.35, 0.55);
    ctx.shadowBlur = 0;
    if (v.id === selected) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 0.35;
      roundRect(-len / 2 - 0.8, -wid / 2 - 0.8, len + 1.6, wid + 1.6, 1);
      ctx.stroke();
    }
    ctx.restore();

    // label + alert bubble
    ctx.textAlign = 'center';
    ctx.font = '600 2.6px Inter, sans-serif';
    ctx.fillStyle = 'rgba(230,237,245,.8)';
    const ly = v.ap >= 2 ? v.y : v.y - 2.2;
    const lx = v.ap >= 2 ? v.x + (v.ap === 2 ? 3.6 : -3.6) : v.x;
    ctx.fillText('V' + v.id, lx, ly + (v.ap >= 2 ? 1 : 0));
    if (v.crashed) {
      drawBurst(v.x, v.y, 4 + Math.sin(now / 120) * 0.6);
    } else if (v.alert === 2 || (v.alert === 1 && v.type)) {
      const bx = v.x + 3.2, by = v.y - 4.2;
      ctx.fillStyle = ALERT_COLOR[v.alert];
      ctx.beginPath();
      ctx.moveTo(bx, by - 2.1); ctx.lineTo(bx + 2.2, by + 1.6); ctx.lineTo(bx - 2.2, by + 1.6); ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#111';
      ctx.font = '700 2.6px Inter, sans-serif';
      ctx.fillText('!', bx, by + 1.2);
      if (v.alert === 2 && v.type) {
        ctx.font = '700 2.4px Inter, sans-serif';
        ctx.fillStyle = ALERT_COLOR[2];
        ctx.textAlign = 'left';
        ctx.fillText(v.type, bx + 2.6, by + 1);
      }
    }
  }

  function drawBurst(x, y, r) {
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = 'rgba(251,146,60,.85)';
    ctx.beginPath();
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const rr = i % 2 ? r * 0.5 : r;
      ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
    }
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#fde68a';
    ctx.beginPath(); ctx.arc(0, 0, r * 0.3, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  function frame(now) {
    requestAnimationFrame(frame);
    if (!world) return;
    const offX = (canvas.width - size * dpr) / 2;
    const offY = (canvas.height - size * dpr) / 2;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#111821';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(scale * dpr, 0, 0, scale * dpr, offX, offY);
    drawWorld();
    if (!cur) return;

    const V = lerpVehicles();
    const byId = new Map(V.map((v) => [v.id, v]));
    const C = world.C, B = world.BOX;

    // conflict box flashes when an intersection warning is active
    if (V.some((v) => v.alert === 2 && v.type === 'ICW')) {
      ctx.fillStyle = `rgba(244,63,94,${0.18 + 0.12 * Math.sin(now / 90)})`;
      ctx.fillRect(C - B, C - B, 2 * B, 2 * B);
    }

    const v2v = cur.cfg.v2v;
    // BSM broadcast pulses
    if (v2v && ui.showPulses) {
      for (const v of V) {
        if (v.crashed) continue;
        const phase = ((now / 1000) + v.id * 0.37) % 1;
        ctx.strokeStyle = `rgba(34,211,238,${0.35 * (1 - phase)})`;
        ctx.lineWidth = 0.3;
        ctx.beginPath(); ctx.arc(v.x, v.y, 2 + phase * 16, 0, Math.PI * 2); ctx.stroke();
      }
    }
    // all links
    if (v2v && ui.showLinks && cur.links) {
      ctx.strokeStyle = 'rgba(34,211,238,.13)';
      ctx.lineWidth = 0.25;
      ctx.beginPath();
      for (const [a, b] of cur.links) {
        const p = byId.get(a), q = byId.get(b);
        if (p && q) { ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); }
      }
      ctx.stroke();
    }
    // selected vehicle: radio range, sensor cone, perceived neighbours
    const sv = selected && byId.get(selected);
    if (sv) {
      const h = HEADINGS[sv.ap];
      ctx.fillStyle = 'rgba(163,230,53,.07)';
      ctx.beginPath();
      ctx.moveTo(sv.x, sv.y);
      ctx.arc(sv.x, sv.y, world.SENSOR_RANGE, h - 1.27, h + 1.27);
      ctx.closePath();
      ctx.fill();
      if (v2v) {
        ctx.setLineDash([2, 2]);
        ctx.strokeStyle = 'rgba(34,211,238,.55)';
        ctx.lineWidth = 0.4;
        ctx.beginPath(); ctx.arc(sv.x, sv.y, cur.cfg.range, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
      }
      if (cur.sel) {
        for (const n of cur.sel.nbrs) {
          const q = byId.get(n.id);
          if (!q) continue;
          ctx.strokeStyle = n.src === 'SENSOR' ? 'rgba(163,230,53,.8)' : 'rgba(34,211,238,.8)';
          ctx.lineWidth = 0.4;
          ctx.beginPath(); ctx.moveTo(sv.x, sv.y); ctx.lineTo(q.x, q.y); ctx.stroke();
        }
      }
    }

    for (const v of V) drawVehicle(v, now);

    // crash shock-waves
    crashFx = crashFx.filter((f) => now - f.t < 1200);
    for (const f of crashFx) {
      const k = (now - f.t) / 1200;
      ctx.strokeStyle = `rgba(251,146,60,${1 - k})`;
      ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.arc(f.x, f.y, 3 + k * 20, 0, Math.PI * 2); ctx.stroke();
    }

    if (!v2v) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = 'rgba(251,191,36,.9)';
      ctx.font = `600 ${13 * dpr}px Inter, sans-serif`;
      ctx.textAlign = 'right';
      ctx.fillText('V2V OFF – vehicles rely on line-of-sight sensors only', canvas.width - 12 * dpr, 22 * dpr);
    }
  }

  // ------------------------------------------------------------ input
  canvas.addEventListener('click', (e) => {
    if (!cur || !world) return;
    const r = canvas.getBoundingClientRect();
    const offX = (r.width - size) / 2, offY = (r.height - size) / 2;
    const wx = (e.clientX - r.left - offX) / scale;
    const wy = (e.clientY - r.top - offY) / scale;
    let best = null, bd = 7;
    for (const v of lerpVehicles()) {
      const d = Math.hypot(v.x - wx, v.y - wy);
      if (d < bd) { bd = d; best = v; }
    }
    selected = best ? best.id : null;
    send({ type: 'select', id: selected });
    if (!best) updateObu(null);
  });

  function setMode(on) {
    $('modeV2V').classList.toggle('active', on);
    $('modeOff').classList.toggle('active', !on);
    sendConfig();
  }
  $('modeV2V').onclick = () => setMode(true);
  $('modeOff').onclick = () => setMode(false);

  const sliders = [
    ['range', 'vRange', (v) => v + ' m'],
    ['loss', 'vLoss', (v) => v + ' %'],
    ['rate', 'vRate', (v) => v + ' veh/min'],
  ];
  for (const [id, out, fmt] of sliders) {
    $(id).addEventListener('input', () => { $(out).textContent = fmt($(id).value); sendConfig(); });
  }
  for (const b of document.querySelectorAll('#speed button')) {
    b.onclick = () => {
      document.querySelectorAll('#speed button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      sendConfig();
    };
  }
  $('showLinks').onchange = (e) => { ui.showLinks = e.target.checked; send({ type: 'links', on: ui.showLinks }); };
  $('showPulses').onchange = (e) => { ui.showPulses = e.target.checked; };
  $('btnBrake').onclick = () => send({ type: 'brake' });
  $('btnPause').onclick = () => {
    paused = !paused;
    $('btnPause').textContent = paused ? 'Resume' : 'Pause';
    sendConfig();
  };
  $('btnReset').onclick = () => { $('log').innerHTML = ''; crashFx = []; send({ type: 'reset' }); };

  resize();
  requestAnimationFrame(frame);
  connect();
})();
