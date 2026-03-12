# NeuroSim

NeuroSim is a full-stack evolutionary simulation. A FastAPI backend runs a live 800x800 ecosystem where neural-network-driven agents search for food, avoid poison, burn energy, die, and pass their weights into the next generation through crossover and mutation. A Next.js frontend renders the arena in real time on an HTML5 canvas and charts generation-level learning signals.

## Stack

- Backend: FastAPI, NumPy, WebSockets
- Frontend: Next.js, React, HTML5 Canvas, Chart.js
- Evolution loop: feed-forward neural networks built from raw NumPy matrix math plus a genetic algorithm

## Project layout

```text
backend/
  app/
    main.py
    simulation.py
  requirements.txt
frontend/
  app/
  components/
  lib/
  package.json
README.md
```

## Backend features

- 800x800 toroidal environment
- Random food and poison spawning
- Per-agent feed-forward neural network built from scratch with NumPy
- Core sensory inputs include nearest food distance, nearest poison distance, and current energy
- Signed target bearings are also included so the two-output controller can steer instead of only modulating speed blindly
- Outputs: rotation and thrust
- 30 tick/second simulation loop
- Spatial hashing for local collision checks and nearest-item queries
- Genetic algorithm that:
  - ranks agents by survival time
  - keeps the top 10% as the breeding pool
  - crosses over parent weights
  - mutates 5% of genes
- WebSocket stream at `/ws/simulation`

## Frontend features

- Live WebSocket connection to the backend simulation
- Canvas rendering for:
  - glowing green food
  - glowing red poison
  - triangular agents oriented by heading
  - energy-based agent brightness
  - fading motion trails
- Real-time Chart.js line chart for:
  - average lifespan per generation
  - max fitness per generation

## Run the backend

1. Create and activate a Python virtual environment.
2. Install dependencies:

```bash
cd backend
pip install -r requirements.txt
```

3. Start the API server:

```bash
uvicorn app.main:app --reload
```

The backend will be available at `http://127.0.0.1:8000`, with:

- Health check: `GET /health`
- Snapshot endpoint: `GET /api/snapshot`
- Simulation stream: `ws://127.0.0.1:8000/ws/simulation`

## Run the frontend

1. Install dependencies:

```bash
cd frontend
npm install
```

2. Optionally define a custom backend WebSocket URL:

```bash
set NEXT_PUBLIC_SIM_WS_URL=ws://127.0.0.1:8000/ws/simulation
```

PowerShell alternative for the same session:

```powershell
$env:NEXT_PUBLIC_SIM_WS_URL="ws://127.0.0.1:8000/ws/simulation"
```

3. Start the Next.js app:

```bash
npm run dev
```

The frontend will be available at `http://127.0.0.1:3000`.

## Run both together

Open two terminals:

Terminal 1:

```bash
cd backend
uvicorn app.main:app --reload
```

Terminal 2:

```bash
cd frontend
npm install
npm run dev
```

## Notes

- The frontend defaults to `ws://<current-host>:8000/ws/simulation` if `NEXT_PUBLIC_SIM_WS_URL` is not set.
- Generation history is streamed from the backend so the chart reflects the current evolutionary run.
- Use a dedicated Python virtual environment for the backend. Shared environments may already contain packages that pin older NumPy versions.
