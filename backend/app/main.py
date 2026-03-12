from __future__ import annotations

import asyncio
import contextlib
import json
from typing import Set

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from .simulation import SimulationEngine


FRAME_RATE = 30


class ConnectionHub:
    def __init__(self) -> None:
        self.connections: Set[WebSocket] = set()

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        self.connections.add(websocket)

    def disconnect(self, websocket: WebSocket) -> None:
        self.connections.discard(websocket)

    async def broadcast(self, payload: dict[str, object]) -> None:
        if not self.connections:
            return

        message = json.dumps(payload)
        stale_connections: list[WebSocket] = []
        for websocket in self.connections:
            try:
                await websocket.send_text(message)
            except Exception:
                stale_connections.append(websocket)

        for websocket in stale_connections:
            self.disconnect(websocket)


app = FastAPI(title="NeuroSim", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def startup_event() -> None:
    app.state.hub = ConnectionHub()
    app.state.engine = SimulationEngine()
    app.state.loop_task = asyncio.create_task(simulation_loop(app.state.engine, app.state.hub))


@app.on_event("shutdown")
async def shutdown_event() -> None:
    task: asyncio.Task | None = getattr(app.state, "loop_task", None)
    if task is not None:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task


@app.get("/health")
async def healthcheck() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/snapshot")
async def snapshot() -> dict[str, object]:
    return app.state.engine.snapshot()


@app.websocket("/ws/simulation")
async def simulation_socket(websocket: WebSocket) -> None:
    hub: ConnectionHub = app.state.hub
    engine: SimulationEngine = app.state.engine
    await hub.connect(websocket)
    await websocket.send_json(engine.snapshot())
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        hub.disconnect(websocket)
    except Exception:
        hub.disconnect(websocket)


async def simulation_loop(engine: SimulationEngine, hub: ConnectionHub) -> None:
    frame_interval = 1.0 / FRAME_RATE
    while True:
        payload = engine.step()
        await hub.broadcast(payload)
        await asyncio.sleep(frame_interval)
