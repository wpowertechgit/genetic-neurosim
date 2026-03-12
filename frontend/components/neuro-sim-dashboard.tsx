"use client";

import {
  CategoryScale,
  Chart as ChartJS,
  ChartOptions,
  Legend,
  LineElement,
  LinearScale,
  PointElement,
  Tooltip,
} from "chart.js";
import { Canvas, useFrame } from "@react-three/fiber";
import {
  startTransition,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import type { MutableRefObject, ReactNode } from "react";
import { Line } from "react-chartjs-2";
import { Color, DynamicDrawUsage, InstancedMesh, Object3D } from "three";

import { parseBinaryFrame, type BinaryFrame } from "../lib/binary-protocol";
import type {
  ControlConfig,
  RecordingSummary,
  StatusResponse,
} from "../lib/simulation-types";

ChartJS.register(
  CategoryScale,
  Legend,
  LineElement,
  LinearScale,
  PointElement,
  Tooltip,
);

const WORLD_HALF = 400;
const MAX_RENDERED_AGENTS = 50_000;
const MAX_RENDERED_POINTS = 5_000;
const LIVE_SERIES_LIMIT = 120;

type OverlayStats = {
  generation: number;
  tick: number;
  agentCount: number;
  topFitness: number;
  averageComplexity: number;
  averageLifespan: number;
  halted: boolean;
};

type LivePoint = {
  tick: number;
  alive: number;
  topFitness: number;
  complexity: number;
};

type ControlForm = {
  mutationSeverity: number;
  tickRate: number;
  targetPopulation: number;
  maxGenerations: number;
  sessionName: string;
};

export function NeuroSimDashboard() {
  const latestFrameRef = useRef<BinaryFrame | null>(null);
  const frameRevisionRef = useRef(0);
  const uiUpdateCounterRef = useRef(0);
  const formSeededRef = useRef(false);

  const [overlayStats, setOverlayStats] = useState<OverlayStats>({
    generation: 1,
    tick: 0,
    agentCount: 0,
    topFitness: 0,
    averageComplexity: 0,
    averageLifespan: 0,
    halted: false,
  });
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [recordings, setRecordings] = useState<RecordingSummary[]>([]);
  const [liveSeries, setLiveSeries] = useState<LivePoint[]>([]);
  const [connectionState, setConnectionState] = useState<"connecting" | "live" | "offline">(
    "connecting",
  );
  const [messageCount, setMessageCount] = useState(0);
  const [actionMessage, setActionMessage] = useState("Live session initialized.");
  const [isBusy, setIsBusy] = useState(false);
  const [form, setForm] = useState<ControlForm>({
    mutationSeverity: 12,
    tickRate: 30,
    targetPopulation: 2500,
    maxGenerations: 80,
    sessionName: "",
  });

  const deferredHistory = useDeferredValue(status?.history ?? []);

  const syncFormFromConfig = useEffectEvent((config: ControlConfig) => {
    setForm((current) => ({
      ...current,
      mutationSeverity: Math.round(config.mutation_rate * 100),
      tickRate: config.tick_rate,
      targetPopulation: config.population_size,
      maxGenerations: config.max_generations,
    }));
  });

  const fetchStatus = useEffectEvent(async () => {
    try {
      const response = await fetch(`${resolveApiBase()}/api/status`, { cache: "no-store" });
      if (!response.ok) {
        return;
      }

      const nextStatus = (await response.json()) as StatusResponse;
      startTransition(() => setStatus(nextStatus));
      if (!formSeededRef.current) {
        formSeededRef.current = true;
        syncFormFromConfig(nextStatus.config);
      }
    } catch {
      setConnectionState((current) => (current === "live" ? current : "offline"));
    }
  });

  const fetchRecordings = useEffectEvent(async () => {
    try {
      const response = await fetch(`${resolveApiBase()}/api/recordings`, { cache: "no-store" });
      if (!response.ok) {
        return;
      }

      const nextRecordings = (await response.json()) as RecordingSummary[];
      startTransition(() => setRecordings(nextRecordings));
    } catch {
      setActionMessage("Could not refresh saved sessions.");
    }
  });

  const handleBinaryFrame = useEffectEvent((payload: ArrayBuffer) => {
    const parsed = parseBinaryFrame(payload);
    latestFrameRef.current = parsed;
    frameRevisionRef.current += 1;
    uiUpdateCounterRef.current += 1;

    if (uiUpdateCounterRef.current % 4 === 0) {
      const nextStats: OverlayStats = {
        generation: parsed.generation,
        tick: parsed.tick,
        agentCount: parsed.agentCount,
        topFitness: parsed.topFitness,
        averageComplexity: parsed.averageComplexity,
        averageLifespan: parsed.averageLifespan,
        halted: parsed.halted,
      };

      startTransition(() => {
        setOverlayStats(nextStats);
        setMessageCount((value) => value + 4);
        setLiveSeries((current) => {
          const next = [
            ...current,
            {
              tick: parsed.tick,
              alive: parsed.agentCount,
              topFitness: parsed.topFitness,
              complexity: parsed.averageComplexity,
            },
          ];
          return next.slice(-LIVE_SERIES_LIMIT);
        });
      });
    }

    setConnectionState("live");
  });

  useEffect(() => {
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let cancelled = false;

    const connect = () => {
      setConnectionState("connecting");
      socket = new WebSocket(resolveWsUrl());
      socket.binaryType = "arraybuffer";

      socket.onopen = () => {
        setConnectionState("live");
      };

      socket.onmessage = async (event) => {
        if (event.data instanceof ArrayBuffer) {
          handleBinaryFrame(event.data);
          return;
        }
        if (event.data instanceof Blob) {
          handleBinaryFrame(await event.data.arrayBuffer());
        }
      };

      socket.onerror = () => {
        socket?.close();
      };

      socket.onclose = () => {
        if (cancelled) {
          return;
        }
        setConnectionState("offline");
        reconnectTimer = window.setTimeout(connect, 1200);
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
      }
      socket?.close();
    };
  }, [handleBinaryFrame]);

  useEffect(() => {
    fetchStatus();
    fetchRecordings();
    const statusInterval = window.setInterval(fetchStatus, 1000);
    const recordingInterval = window.setInterval(fetchRecordings, 4000);
    return () => {
      window.clearInterval(statusInterval);
      window.clearInterval(recordingInterval);
    };
  }, [fetchRecordings, fetchStatus]);

  const applyConfig = useEffectEvent(async () => {
    const fallbackConfig: ControlConfig = status?.config ?? {
      mutation_rate: 0.12,
      population_size: 2500,
      max_generations: 80,
      food_spawn_rate: 24,
      energy_decay: 0.82,
      tick_rate: 30,
    };

    setIsBusy(true);
    setActionMessage("Applying simulation parameters...");

    try {
      const response = await fetch(`${resolveApiBase()}/api/config`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          mutation_rate: form.mutationSeverity / 100,
          population_size: form.targetPopulation,
          max_generations: form.maxGenerations,
          food_spawn_rate: fallbackConfig.food_spawn_rate,
          energy_decay: fallbackConfig.energy_decay,
          tick_rate: form.tickRate,
        }),
      });

      if (!response.ok) {
        throw new Error("config update failed");
      }

      await fetchStatus();
      setActionMessage("Simulation parameters updated.");
    } catch {
      setActionMessage("Config update failed.");
    } finally {
      setIsBusy(false);
    }
  });

  const saveRecording = useEffectEvent(async () => {
    setIsBusy(true);
    setActionMessage("Saving current session for offline replay...");

    try {
      const response = await fetch(`${resolveApiBase()}/api/recordings/save`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: form.sessionName.trim() || undefined,
        }),
      });

      if (!response.ok) {
        throw new Error("save failed");
      }

      const saved = (await response.json()) as RecordingSummary;
      await fetchRecordings();
      await fetchStatus();
      setActionMessage(`Saved ${saved.name}.`);
    } catch {
      setActionMessage("Could not save the current session.");
    } finally {
      setIsBusy(false);
    }
  });

  const replayRecording = useEffectEvent(async (recordingId: string) => {
    setIsBusy(true);
    setActionMessage("Reconstructing saved session...");

    try {
      const response = await fetch(`${resolveApiBase()}/api/recordings/replay`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ recording_id: recordingId }),
      });

      if (!response.ok) {
        throw new Error("replay failed");
      }

      await fetchStatus();
      setLiveSeries([]);
      setActionMessage(`Replay started from ${recordingId}.`);
    } catch {
      setActionMessage("Replay request failed.");
    } finally {
      setIsBusy(false);
    }
  });

  const triggerGodMode = useEffectEvent(async () => {
    setIsBusy(true);
    setActionMessage("Forcing a bottleneck...");

    try {
      const response = await fetch(`${resolveApiBase()}/api/god-mode`, {
        method: "POST",
      });
      if (!response.ok) {
        throw new Error("god mode failed");
      }

      await fetchStatus();
      setActionMessage("Population culled by 50%.");
    } catch {
      setActionMessage("God Mode request failed.");
    } finally {
      setIsBusy(false);
    }
  });

  const liveChartData = {
    labels: liveSeries.map((point) => point.tick.toString()),
    datasets: [
      {
        label: "Alive",
        data: liveSeries.map((point) => point.alive),
        borderColor: "#ffffff",
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.15,
      },
      {
        label: "Top Fitness",
        data: liveSeries.map((point) => point.topFitness),
        borderColor: "#9ca3af",
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.15,
      },
      {
        label: "Complexity",
        data: liveSeries.map((point) => point.complexity),
        borderColor: "#525252",
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.15,
      },
    ],
  };

  const liveChartOptions: ChartOptions<"line"> = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    plugins: {
      legend: {
        labels: {
          color: "#d4d4d8",
        },
      },
      tooltip: {
        backgroundColor: "#111111",
        titleColor: "#fafafa",
        bodyColor: "#d4d4d8",
      },
    },
    scales: {
      x: {
        ticks: {
          color: "#737373",
          maxTicksLimit: 6,
        },
        grid: {
          color: "rgba(82, 82, 82, 0.25)",
        },
      },
      y: {
        ticks: {
          color: "#737373",
        },
        grid: {
          color: "rgba(82, 82, 82, 0.25)",
        },
      },
    },
  };

  return (
    <main className="h-screen w-screen overflow-hidden bg-neutral-950 text-neutral-100">
      <div className="relative h-full w-full">
        <SimulationViewport
          frameRef={latestFrameRef}
          revisionRef={frameRevisionRef}
          halted={overlayStats.halted}
        />

        <OverlayPanel className="left-4 top-4 w-[320px]">
          <p className="font-mono text-[11px] uppercase tracking-[0.34em] text-neutral-500">
            Live Session
          </p>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <Stat label="Generation" value={overlayStats.generation.toString()} />
            <Stat label="Tick" value={overlayStats.tick.toString()} />
            <Stat label="Alive" value={overlayStats.agentCount.toLocaleString()} />
            <Stat label="Frames" value={messageCount.toLocaleString()} />
            <Stat label="Fitness" value={overlayStats.topFitness.toFixed(1)} />
            <Stat label="Complexity" value={overlayStats.averageComplexity.toFixed(1)} />
          </div>
          <div className="mt-4 flex items-center justify-between text-xs uppercase tracking-[0.28em] text-neutral-400">
            <span>{connectionState === "live" ? "streaming" : connectionState}</span>
            <span>{status?.session.replaying ? "replay mode" : "live mode"}</span>
          </div>
          <p className="mt-3 text-sm text-neutral-400">{actionMessage}</p>
        </OverlayPanel>

        <OverlayPanel className="right-4 top-4 w-[360px]">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="font-mono text-[11px] uppercase tracking-[0.34em] text-neutral-500">
                Configuration
              </p>
              <h2 className="mt-2 text-xl font-medium text-white">Run Controls</h2>
            </div>
            <span className="rounded border border-neutral-800 px-2 py-1 text-[11px] uppercase tracking-[0.24em] text-neutral-400">
              Seed {status?.session.seed ?? 7}
            </span>
          </div>

          <div className="mt-5 space-y-4">
            <RangeField
              label="Mutation Severity"
              value={form.mutationSeverity}
              min={0}
              max={100}
              unit="%"
              onChange={(value) => setForm((current) => ({ ...current, mutationSeverity: value }))}
            />

            <NumberField
              label="Tick Rate"
              value={form.tickRate}
              min={1}
              max={120}
              onChange={(value) => setForm((current) => ({ ...current, tickRate: value }))}
            />
            <NumberField
              label="Population"
              value={form.targetPopulation}
              min={250}
              max={50000}
              step={100}
              onChange={(value) => setForm((current) => ({ ...current, targetPopulation: value }))}
            />
            <NumberField
              label="Generations"
              value={form.maxGenerations}
              min={1}
              max={5000}
              onChange={(value) => setForm((current) => ({ ...current, maxGenerations: value }))}
            />
            <input
              type="text"
              value={form.sessionName}
              onChange={(event) =>
                setForm((current) => ({ ...current, sessionName: event.target.value }))
              }
              placeholder="Session name for offline save"
              className="w-full rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-white outline-none placeholder:text-neutral-600"
            />
          </div>

          <div className="mt-5 grid grid-cols-2 gap-3">
            <ActionButton label="Apply" onClick={applyConfig} disabled={isBusy} />
            <ActionButton label="God Mode" onClick={triggerGodMode} disabled={isBusy} />
            <ActionButton label="Save Session" onClick={saveRecording} disabled={isBusy} />
            <ActionButton
              label={status?.session.recording_dirty ? "Unsaved" : "Saved"}
              onClick={saveRecording}
              disabled={isBusy || !status?.session.recording_dirty}
            />
          </div>
        </OverlayPanel>

        <OverlayPanel className="bottom-4 right-4 h-[300px] w-[420px]">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="font-mono text-[11px] uppercase tracking-[0.34em] text-neutral-500">
                Live Telemetry
              </p>
              <h2 className="mt-2 text-xl font-medium text-white">Running Graph</h2>
            </div>
            <div className="text-right text-xs text-neutral-500">
              <div>Avg lifespan {overlayStats.averageLifespan.toFixed(1)}</div>
              <div>History {deferredHistory.length} generations</div>
            </div>
          </div>
          <div className="mt-4 h-[205px]">
            <Line data={liveChartData} options={liveChartOptions} />
          </div>
        </OverlayPanel>

        <OverlayPanel className="bottom-4 left-4 w-[420px]">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="font-mono text-[11px] uppercase tracking-[0.34em] text-neutral-500">
                Offline Replay
              </p>
              <h2 className="mt-2 text-xl font-medium text-white">Saved Sessions</h2>
            </div>
            <span className="text-xs text-neutral-500">
              {recordings.length.toLocaleString()} stored
            </span>
          </div>

          <div className="mt-4 max-h-[240px] space-y-2 overflow-auto pr-1">
            {recordings.length === 0 ? (
              <p className="text-sm text-neutral-500">
                No saved sessions yet. Save the current run to replay it later.
              </p>
            ) : (
              recordings.map((recording) => (
                <button
                  key={recording.id}
                  type="button"
                  onClick={() => replayRecording(recording.id)}
                  className="w-full rounded border border-neutral-800 bg-neutral-950 px-3 py-3 text-left transition hover:border-neutral-600"
                  disabled={isBusy}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-medium text-white">{recording.name}</div>
                      <div className="mt-1 text-xs text-neutral-500">
                        Gen {recording.final_generation} / Tick {recording.final_tick}
                      </div>
                    </div>
                    <div className="text-right text-xs text-neutral-500">
                      <div>{recording.population_size.toLocaleString()} agents</div>
                      <div>{new Date(recording.saved_at_ms).toLocaleString()}</div>
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
        </OverlayPanel>
      </div>
    </main>
  );
}

function SimulationViewport({
  frameRef,
  revisionRef,
  halted,
}: {
  frameRef: MutableRefObject<BinaryFrame | null>;
  revisionRef: MutableRefObject<number>;
  halted: boolean;
}) {
  return (
    <Canvas camera={{ position: [0, 320, 320], fov: 48 }}>
      <color attach="background" args={["#0a0a0a"]} />
      <ambientLight intensity={0.55} />
      <directionalLight position={[80, 180, 90]} intensity={1.0} color="#ffffff" />
      <group rotation={[-0.95, 0, 0]}>
        <mesh position={[0, -4, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[860, 860, 1, 1]} />
          <meshStandardMaterial color={halted ? "#141414" : "#111111"} roughness={1} metalness={0} />
        </mesh>
        <ArenaInstancing frameRef={frameRef} revisionRef={revisionRef} />
      </group>
    </Canvas>
  );
}

function ArenaInstancing({
  frameRef,
  revisionRef,
}: {
  frameRef: MutableRefObject<BinaryFrame | null>;
  revisionRef: MutableRefObject<number>;
}) {
  const agentMesh = useRef<InstancedMesh>(null);
  const foodMesh = useRef<InstancedMesh>(null);
  const poisonMesh = useRef<InstancedMesh>(null);
  const appliedRevisionRef = useRef(0);
  const agentDummy = useRef(new Object3D());
  const pointDummy = useRef(new Object3D());
  const agentColor = useRef(new Color());

  useEffect(() => {
    if (agentMesh.current) {
      agentMesh.current.instanceMatrix.setUsage(DynamicDrawUsage);
    }
    if (foodMesh.current) {
      foodMesh.current.instanceMatrix.setUsage(DynamicDrawUsage);
    }
    if (poisonMesh.current) {
      poisonMesh.current.instanceMatrix.setUsage(DynamicDrawUsage);
    }
  }, []);

  useFrame(() => {
    if (
      !agentMesh.current ||
      !foodMesh.current ||
      !poisonMesh.current ||
      revisionRef.current === appliedRevisionRef.current
    ) {
      return;
    }

    const frame = frameRef.current;
    if (!frame) {
      return;
    }

    appliedRevisionRef.current = revisionRef.current;

    const agentLimit = Math.min(frame.agentCount, MAX_RENDERED_AGENTS);
    const foodLimit = Math.min(frame.foodCount, MAX_RENDERED_POINTS);
    const poisonLimit = Math.min(frame.poisonCount, MAX_RENDERED_POINTS);
    const agentTarget = agentMesh.current;
    const foodTarget = foodMesh.current;
    const poisonTarget = poisonMesh.current;

    for (let index = 0; index < agentLimit; index += 1) {
      const offset = index * 4;
      const x = frame.agents[offset] - WORLD_HALF;
      const z = frame.agents[offset + 1] - WORLD_HALF;
      const energy = frame.agents[offset + 2];
      const angle = frame.agents[offset + 3];
      const energyRatio = Math.max(0.12, Math.min(1, energy / 200));
      const shade = 0.18 + energyRatio * 0.82;

      agentDummy.current.position.set(x, 2.2, z);
      agentDummy.current.rotation.set(Math.PI / 2, angle, 0);
      agentDummy.current.scale.setScalar(energyRatio * 1.05 + 0.55);
      agentDummy.current.updateMatrix();
      agentTarget.setMatrixAt(index, agentDummy.current.matrix);

      agentColor.current.setRGB(shade, shade, shade);
      agentTarget.setColorAt(index, agentColor.current);
    }

    for (let index = 0; index < foodLimit; index += 1) {
      const offset = index * 2;
      pointDummy.current.position.set(
        frame.food[offset] - WORLD_HALF,
        1.1,
        frame.food[offset + 1] - WORLD_HALF,
      );
      pointDummy.current.scale.setScalar(0.9);
      pointDummy.current.updateMatrix();
      foodTarget.setMatrixAt(index, pointDummy.current.matrix);
    }

    for (let index = 0; index < poisonLimit; index += 1) {
      const offset = index * 2;
      pointDummy.current.position.set(
        frame.poison[offset] - WORLD_HALF,
        1.05,
        frame.poison[offset + 1] - WORLD_HALF,
      );
      pointDummy.current.scale.setScalar(0.9);
      pointDummy.current.updateMatrix();
      poisonTarget.setMatrixAt(index, pointDummy.current.matrix);
    }

    agentTarget.count = agentLimit;
    foodTarget.count = foodLimit;
    poisonTarget.count = poisonLimit;
    agentTarget.instanceMatrix.needsUpdate = true;
    foodTarget.instanceMatrix.needsUpdate = true;
    poisonTarget.instanceMatrix.needsUpdate = true;
    if (agentTarget.instanceColor) {
      agentTarget.instanceColor.needsUpdate = true;
    }
  });

  return (
    <>
      <instancedMesh ref={agentMesh} args={[undefined, undefined, MAX_RENDERED_AGENTS]}>
        <coneGeometry args={[1.55, 3.8, 3]} />
        <meshStandardMaterial vertexColors roughness={0.55} metalness={0.02} />
      </instancedMesh>

      <instancedMesh ref={foodMesh} args={[undefined, undefined, MAX_RENDERED_POINTS]}>
        <sphereGeometry args={[0.95, 6, 6]} />
        <meshBasicMaterial color="#d4d4d8" />
      </instancedMesh>

      <instancedMesh ref={poisonMesh} args={[undefined, undefined, MAX_RENDERED_POINTS]}>
        <sphereGeometry args={[0.85, 6, 6]} />
        <meshBasicMaterial color="#525252" />
      </instancedMesh>
    </>
  );
}

function OverlayPanel({
  children,
  className,
}: {
  children: ReactNode;
  className: string;
}) {
  return (
    <section
      className={`absolute rounded border border-neutral-800 bg-neutral-900/92 p-4 shadow-2xl backdrop-blur ${className}`}
    >
      {children}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-neutral-800 bg-neutral-950 px-3 py-2">
      <div className="font-mono text-[11px] uppercase tracking-[0.24em] text-neutral-500">
        {label}
      </div>
      <div className="mt-2 text-lg text-white">{value}</div>
    </div>
  );
}

function RangeField({
  label,
  value,
  min,
  max,
  unit,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  unit: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block">
      <div className="mb-2 flex items-center justify-between text-sm">
        <span className="text-neutral-300">{label}</span>
        <span className="font-mono text-xs text-neutral-500">
          {value}
          {unit}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-2 w-full cursor-pointer appearance-none rounded bg-neutral-800 accent-white"
      />
    </label>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block">
      <div className="mb-2 text-sm text-neutral-300">{label}</div>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="w-full rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-white outline-none"
      />
    </label>
  );
}

function ActionButton({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-white transition hover:border-neutral-500 disabled:cursor-not-allowed disabled:text-neutral-600"
    >
      {label}
    </button>
  );
}

function resolveApiBase() {
  const configured = process.env.NEXT_PUBLIC_SIM_API_URL;
  if (configured) {
    return configured;
  }

  if (typeof window === "undefined") {
    return "http://127.0.0.1:8000";
  }

  return `${window.location.protocol}//${window.location.hostname}:8000`;
}

function resolveWsUrl() {
  const configured = process.env.NEXT_PUBLIC_SIM_WS_URL;
  if (configured) {
    return configured;
  }

  if (typeof window === "undefined") {
    return "ws://127.0.0.1:8000/ws/simulation";
  }

  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${window.location.hostname}:8000/ws/simulation`;
}
