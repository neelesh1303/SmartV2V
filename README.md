# SmartV2V – Software-Based Vehicle-to-Vehicle Communication & Collision Warning System

A real-time, browser-based demonstration of **V2V (Vehicle-to-Vehicle) communication** and **collision warning** at a blind 4-way intersection.

Vehicles move dynamically, broadcast **Basic Safety Messages (BSM)** 10 times per second over a simulated wireless channel, and every vehicle's **On-Board Unit (OBU)** decides when to warn / brake / yield using **only the messages it received** plus its own line-of-sight sensors.

Flip the switch to **SENSORS ONLY** and watch collisions happen at the blind corners — then switch **V2V ON** and see them disappear.

## Features

- Live simulation (20 Hz) streamed to the browser over **WebSockets**
- BSM broadcast: position, heading, speed, acceleration, brake status, waiting time
- Simulated radio channel: configurable **range**, **packet loss**, 10–50 ms **latency**
- Collision warning algorithms running on every vehicle:
  - **FCW** – Forward Collision Warning (time-to-collision with the vehicle ahead)
  - **EEBL** – Emergency Electronic Brake Light (vehicle ahead braking hard)
  - **ICW** – Intersection Collision Warning (crossing traffic, priority negotiation and yielding)
  - **Hazard** – stationary / crashed vehicle ahead
- Buildings block on-board sensors (radar/camera); V2V works without line-of-sight
- Click any vehicle to inspect its OBU: speed, TTC, decision, neighbour table with message age and source
- Live statistics: BSM/s, packet delivery ratio, latency, warnings, collisions
- Controls: V2V on/off, radio range, packet loss, traffic density, sim speed, emergency-brake event, pause, reset

## Run locally

```bash
npm install
npm start
# open http://localhost:3000
```

## Deploy on Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/neelesh1303/SmartV2V)

The repo includes `render.yaml`. On Render: **New → Blueprint** (or **New → Web Service**) → connect this repo.
Build command `npm install`, start command `npm start`. WebSockets work out of the box.

## Project structure

```
server.js            Express + WebSocket server (one simulation per browser session)
src/simulation.js    Vehicle dynamics, V2V radio channel, OBU warning logic
public/              Front-end (canvas renderer, dashboard)
render.yaml          Render deployment blueprint
```

## How it works

1. **Mobility** – vehicles follow lanes (left-hand traffic) using the Intelligent Driver Model.
2. **Broadcast** – every 100 ms each OBU broadcasts a BSM.
3. **Channel** – each receiver within radio range gets the packet with probability `1 − loss`, after 10–50 ms.
4. **Perception** – the OBU keeps a neighbour table (expires after 1 s) and dead-reckons positions to "now".
5. **Threat assessment** – TTC for following; junction occupancy-time overlap for crossing traffic.
6. **Action** – caution warning (TTC < 4 s), danger warning + automatic braking (TTC < 2 s), or yield at the stop line.
