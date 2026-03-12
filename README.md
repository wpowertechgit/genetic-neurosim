# NeuroSim v2

NeuroSim v2 is a real-time artificial life system with a Rust simulation backend and a Next.js + React Three Fiber control deck. The backend evolves agents with NEAT-style topology mutation, broadcasts the arena as compact binary websocket frames, and exposes REST controls for live configuration changes and forced evolutionary bottlenecks.

## Stack

- Backend: Rust, Axum, Tokio, Rayon
- Simulation core: ECS-style data layout, spatial hash grid, NEAT-inspired genomes with node/link mutations
- Frontend: Next.js 16, React 19, React Three Fiber, Tailwind CSS, Chart.js

## Project layout

```text
backend/
  Cargo.toml
  src/
    main.rs
    simulation.rs
frontend/
  app/
  components/
  lib/
  package.json
README.md
```

## Backend highlights

- Axum websocket endpoint at `/ws/simulation`
- REST control API:
  - `GET /health`
  - `GET /api/status`
  - `GET /api/config`
  - `POST /api/config`
  - `POST /api/god-mode`
  - `GET /api/recordings`
  - `POST /api/recordings/save`
  - `POST /api/recordings/replay`
- ECS-style storage using flat component arrays for positions, velocities, energy, angle, fitness, and genomes
- NEAT-style evolution:
  - connection weight mutation
  - add-connection mutation
  - add-node mutation by splitting an existing connection
  - innovation tracking for structural mutations
- Parallel agent update loop and collision candidate generation via Rayon
- Spatial hash grid for nearest-target sensing and consumable collision checks
- Raw binary websocket frames:
  - header: generation, tick, counts, halt flag, top fitness, average lifespan, average brain complexity
  - payload: packed float arrays for agents, food, and poison
- Server-side halt when the configured generation limit is reached
- God Mode endpoint that randomly kills 50% of the current population
- Offline session saving and deterministic replay reconstruction from:
  - initial seed
  - initial config
  - recorded runtime control events

## Frontend highlights

- Binary websocket parsing with `DataView` and `Float32Array`
- `@react-three/fiber` arena with `InstancedMesh` rendering for up to 50,000 agents in one draw path
- Overlay-based UI with floating control, telemetry, and replay panels
- Runtime controls for:
  - mutation severity
  - tick rate speed
  - target population
  - max generations
- Chart.js analytics for:
  - live alive count
  - live top fitness
  - live average brain complexity

## Binary protocol

The websocket sends a single little-endian binary frame format:

```text
Header (36 bytes)
  u32 generation
  u32 tick
  u32 alive_agent_count
  u32 food_count
  u32 poison_count
  u32 halted_flag
  f32 top_fitness
  f32 average_lifespan
  f32 average_brain_complexity

Payload
  agents: [x, y, energy, angle] * alive_agent_count
  food:   [x, y] * food_count
  poison: [x, y] * poison_count
```

This lets the frontend decode frames with direct byte offsets and no JSON parsing overhead.

## Install and run

### Backend

```bash
cd backend
cargo run
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

The frontend runs at `http://127.0.0.1:3000` and the backend listens on `http://127.0.0.1:8000`.

## Environment variables

Optional frontend overrides:

```powershell
$env:NEXT_PUBLIC_SIM_API_URL="http://127.0.0.1:8000"
$env:NEXT_PUBLIC_SIM_WS_URL="ws://127.0.0.1:8000/ws/simulation"
```

## Run both on Windows

From the repository root:

```powershell
.\start.ps1
```

Or:

```bat
start.bat
```

The script starts `cargo run` for the Rust backend and `npm run dev` for the Next.js frontend in separate PowerShell windows. If `frontend/node_modules` is missing, it runs `npm install` first.

## Verification

The current rewrite has been verified locally with:

```bash
cd backend && cargo check
cd frontend && npx tsc --noEmit
cd frontend && npm run build
```

