'use strict';
const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const { Simulation, WORLD, C, LANE_W, BOX, BUILDINGS, SENSOR_RANGE } = require('./src/simulation');

const PORT = process.env.PORT || 3000;
const TICK_MS = 50; // 20 Hz simulation + broadcast

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));
app.get('/api/world', (_req, res) => res.json({ WORLD, C, LANE_W, BOX, BUILDINGS, SENSOR_RANGE }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// Each browser session gets its own independent simulation instance.
wss.on('connection', (ws) => {
  const sim = new Simulation();
  const view = { selected: null, links: false };
  sim.log('sys', 'Connected - SmartV2V simulation started');

  ws.send(JSON.stringify({ type: 'world', world: { WORLD, C, LANE_W, BOX, BUILDINGS, SENSOR_RANGE } }));

  const timer = setInterval(() => {
    if (!sim.config.paused) {
      // keep step size small for stable physics; run extra steps when sped up
      const total = (TICK_MS / 1000) * sim.config.speed;
      const n = Math.max(1, Math.round(total / 0.05));
      for (let i = 0; i < n; i++) sim.step(total / n);
    }
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'state', ...sim.snapshot(view) }));
    }
  }, TICK_MS);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    switch (msg.type) {
      case 'config': sim.setConfig(msg.config || {}); break;
      case 'select': view.selected = Number.isFinite(msg.id) ? msg.id : null; break;
      case 'links': view.links = !!msg.on; break;
      case 'brake': sim.triggerEmergencyBrake(); break;
      case 'reset': {
        const cfg = { ...sim.config };
        sim.reset();
        sim.config = cfg;
        sim.log('sys', 'Simulation reset');
        break;
      }
      default: break;
    }
  });

  ws.on('close', () => clearInterval(timer));
  ws.on('error', () => clearInterval(timer));
});

server.listen(PORT, () => console.log(`SmartV2V running on http://localhost:${PORT}`));
