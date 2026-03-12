"use client";

import {
  CategoryScale,
  Chart as ChartJS,
  ChartOptions,
  Filler,
  Legend,
  LineElement,
  LinearScale,
  PointElement,
  Tooltip,
} from "chart.js";
import { Canvas } from "@react-three/fiber";
import {
  startTransition,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import { Line } from "react-chartjs-2";
import {
  Color,
  DynamicDrawUsage,
  InstancedMesh,
  Object3D,
} from "three";

import { parseBinaryFrame, type BinaryFrame } from "../lib/binary-protocol";
import type { ControlConfig, StatusResponse } from "../lib/simulation-types";

ChartJS.register(CategoryScale, Filler, Legend, LineElement, LinearScale, PointElement, Tooltip);

const WORLD_HALF = 400;
const MAX_RENDERED_AGENTS = 50_000;
const MAX_RENDERED_POINTS = 5_000;

type ControlForm = {
  mutationSeverity: number;
  tickRate: number;
  targetPopulation: number;
};

export function NeuroSimDashboard() {
  const [frame, setFrame] = useState<BinaryFrame | null>(null);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [connectionState, setConnectionState] = useState<"connecting" | "live" | "offline">(
    "connecting",
  );
  const [messageCount, setMessageCount] = useState(0);
  const [actionMessage, setActionMessage] = useState("Control plane idle.");
  const [form, setForm] = useState<ControlForm>({
    mutationSeverity: 12,
    tickRate: 30,
    targetPopulation: 8000,
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const formSeededRef = useRef(false);
  const deferredHistory = useDeferredValue(status?.history ?? []);

  const handleBinaryFrame = useEffectEvent((payload: ArrayBuffer) => {
    const parsed = parseBinaryFrame(payload);
    startTransition(() => {
      setFrame(parsed);
      setMessageCount((value) => value + 1);
      setConnectionState("live");
    });
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
        setForm({
          mutationSeverity: Math.round(nextStatus.config.mutation_rate * 100),
          tickRate: nextStatus.config.tick_rate,
          targetPopulation: nextStatus.config.population_size,
        });
      }
    } catch {
      setConnectionState((current) => (current === "live" ? current : "offline"));
    }
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
        reconnectTimer = window.setTimeout(connect, 1500);
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
    const interval = window.setInterval(fetchStatus, 1000);
    return () => window.clearInterval(interval);
  }, [fetchStatus]);

  const applyConfig = useEffectEvent(async () => {
    const fallbackConfig: ControlConfig = status?.config ?? {
      mutation_rate: 0.12,
      population_size: 8000,
      max_generations: 250,
      food_spawn_rate: 28,
      energy_decay: 0.65,
      tick_rate: 30,
    };

    setIsSubmitting(true);
    setActionMessage("Applying runtime parameters to the Rust control API...");

    try {
      const response = await fetch(`${resolveApiBase()}/api/config`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          mutation_rate: form.mutationSeverity / 100,
          population_size: form.targetPopulation,
          max_generations: fallbackConfig.max_generations,
          food_spawn_rate: fallbackConfig.food_spawn_rate,
          energy_decay: fallbackConfig.energy_decay,
          tick_rate: form.tickRate,
        }),
      });

      if (!response.ok) {
        throw new Error("config update failed");
      }

      await fetchStatus();
      setActionMessage("Runtime parameters updated.");
    } catch {
      setActionMessage("Config update failed.");
    } finally {
      setIsSubmitting(false);
    }
  });

  const triggerGodMode = useEffectEvent(async () => {
    setIsSubmitting(true);
    setActionMessage("Issuing God Mode population bottleneck...");

    try {
      const response = await fetch(`${resolveApiBase()}/api/god-mode`, {
        method: "POST",
      });
      if (!response.ok) {
        throw new Error("god mode failed");
      }
      const payload = (await response.json()) as { removed_agents: number; alive_after: number };
      await fetchStatus();
      setActionMessage(
        `God Mode culled ${payload.removed_agents.toLocaleString()} agents. ${payload.alive_after.toLocaleString()} remain.`,
      );
    } catch {
      setActionMessage("God Mode request failed.");
    } finally {
      setIsSubmitting(false);
    }
  });

  const chartData = {
    labels: deferredHistory.map((entry) => `G${entry.generation}`),
    datasets: [
      {
        label: "Average Lifespan",
        data: deferredHistory.map((entry) => entry.average_lifespan),
        borderColor: "#4ade80",
        backgroundColor: "rgba(74, 222, 128, 0.12)",
        borderWidth: 2,
        pointRadius: 0,
        fill: true,
        tension: 0.28,
      },
      {
        label: "Max Fitness",
        data: deferredHistory.map((entry) => entry.max_fitness),
        borderColor: "#38bdf8",
        backgroundColor: "rgba(56, 189, 248, 0.06)",
        borderWidth: 2,
        pointRadius: 0,
        fill: false,
        tension: 0.24,
      },
      {
        label: "Average Brain Complexity",
        data: deferredHistory.map((entry) => entry.average_brain_complexity),
        borderColor: "#f97316",
        backgroundColor: "rgba(249, 115, 22, 0.06)",
        borderWidth: 2,
        pointRadius: 0,
        fill: false,
        tension: 0.22,
      },
    ],
  };

  const chartOptions: ChartOptions<"line"> = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: {
      mode: "index",
      intersect: false,
    },
    plugins: {
      legend: {
        labels: {
          color: "#dbeafe",
        },
      },
      tooltip: {
        backgroundColor: "#020617",
        titleColor: "#f8fafc",
        bodyColor: "#cbd5e1",
      },
    },
    scales: {
      x: {
        ticks: {
          color: "#94a3b8",
          maxTicksLimit: 12,
        },
        grid: {
          color: "rgba(148, 163, 184, 0.12)",
        },
      },
      y: {
        ticks: {
          color: "#94a3b8",
        },
        grid: {
          color: "rgba(148, 163, 184, 0.12)",
        },
      },
    },
  };

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-[1600px] flex-col gap-6 px-4 py-4 sm:px-6 lg:px-8">
      <section className="glass-panel relative overflow-hidden rounded-[32px] p-6 sm:p-8">
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-300/60 to-transparent" />
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1.45fr)_380px]">
          <div className="space-y-5">
            <p className="font-mono text-xs uppercase tracking-[0.38em] text-cyan-300/80">
              NeuroSim v2 / Rust + WebGL Instancing
            </p>
            <h1 className="max-w-4xl font-display text-4xl font-semibold leading-[0.95] text-white sm:text-6xl">
              NEAT topologies evolving in a binary-streamed arena.
            </h1>
            <p className="max-w-3xl text-base leading-7 text-slate-300 sm:text-lg">
              The backend runs a data-oriented Rust simulation with topology mutations, spatial
              hashing, and rayon-parallel agent updates. The frontend decodes raw websocket frames
              directly into instanced transforms for massive populations.
            </p>
          </div>

          <div className="grid gap-3 self-start">
            <ConnectionBadge state={connectionState} />
            <MetricCard label="Frames Seen" value={messageCount.toLocaleString()} />
            <MetricCard
              label="Generation"
              value={(status?.generation ?? frame?.generation ?? 1).toLocaleString()}
            />
            <MetricCard
              label="Halt State"
              value={status?.halted || frame?.halted ? "Reached limit" : "Running"}
            />
          </div>
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-[minmax(0,1.55fr)_420px]">
        <article className="glass-panel rounded-[32px] p-3 sm:p-4">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-4 px-2 sm:px-3">
            <div>
              <p className="font-mono text-xs uppercase tracking-[0.34em] text-slate-400">
                Simulation Arena
              </p>
              <h2 className="mt-2 font-display text-2xl text-white sm:text-3xl">
                50k-agent instanced render path
              </h2>
            </div>
            <div className="flex flex-wrap gap-2 text-xs uppercase tracking-[0.28em] text-slate-300">
              <LegendBadge color="bg-emerald-400" label="Food" />
              <LegendBadge color="bg-rose-400" label="Poison" />
              <LegendBadge color="bg-slate-100" label="Agents" />
            </div>
          </div>
          <div className="h-[60vh] min-h-[420px] overflow-hidden rounded-[26px] border border-white/10 bg-slate-950">
            <SimulationViewport frame={frame} />
          </div>
        </article>

        <aside className="space-y-6">
          <section className="glass-panel rounded-[32px] p-5 sm:p-6">
            <div className="mb-5 flex items-center justify-between gap-3">
              <div>
                <p className="font-mono text-xs uppercase tracking-[0.34em] text-slate-400">
                  Command Deck
                </p>
                <h2 className="mt-2 font-display text-2xl text-white">Live Runtime Controls</h2>
              </div>
            </div>

            <div className="space-y-5">
              <SliderField
                label="Mutation Severity"
                value={form.mutationSeverity}
                min={0}
                max={100}
                unit="%"
                onChange={(value) => setForm((current) => ({ ...current, mutationSeverity: value }))}
              />
              <SliderField
                label="Tick Rate Speed"
                value={form.tickRate}
                min={1}
                max={120}
                unit="tps"
                onChange={(value) => setForm((current) => ({ ...current, tickRate: value }))}
              />
              <SliderField
                label="Target Population"
                value={form.targetPopulation}
                min={500}
                max={50000}
                unit=""
                step={100}
                onChange={(value) => setForm((current) => ({ ...current, targetPopulation: value }))}
              />

              <div className="flex flex-col gap-3 pt-2 sm:flex-row">
                <button
                  type="button"
                  onClick={applyConfig}
                  disabled={isSubmitting}
                  className="rounded-full bg-cyan-400 px-5 py-3 font-mono text-xs uppercase tracking-[0.28em] text-slate-950 transition hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Apply Config
                </button>
                <button
                  type="button"
                  onClick={triggerGodMode}
                  disabled={isSubmitting}
                  className="rounded-full border border-rose-400/50 bg-rose-500/10 px-5 py-3 font-mono text-xs uppercase tracking-[0.28em] text-rose-200 transition hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  God Mode
                </button>
              </div>
            </div>

            <p className="mt-5 rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-slate-300">
              {actionMessage}
            </p>
          </section>

          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
            <MetricCard
              label="Alive Now"
              value={(status?.metrics.alive ?? 0).toLocaleString()}
              accent="emerald"
            />
            <MetricCard
              label="Population"
              value={(status?.metrics.population ?? 0).toLocaleString()}
              accent="cyan"
            />
            <MetricCard
              label="Avg Energy"
              value={formatMetric(status?.metrics.average_energy)}
              accent="amber"
            />
            <MetricCard
              label="Brain Complexity"
              value={formatMetric(status?.metrics.average_brain_complexity)}
              accent="violet"
            />
          </section>
        </aside>
      </section>

      <section className="glass-panel rounded-[32px] p-5 sm:p-6">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="font-mono text-xs uppercase tracking-[0.34em] text-slate-400">
              Evolution Analytics
            </p>
            <h2 className="mt-2 font-display text-2xl text-white">
              Lifespan, fitness, and neural complexity by generation
            </h2>
          </div>
          <div className="text-sm text-slate-400">
            Polling REST status while rendering raw binary frames over WebSocket.
          </div>
        </div>
        <div className="h-[320px] sm:h-[360px]">
          <Line data={chartData} options={chartOptions} />
        </div>
      </section>
    </main>
  );
}

function SimulationViewport({ frame }: { frame: BinaryFrame | null }) {
  return (
    <Canvas camera={{ position: [0, 320, 320], fov: 50 }}>
      <color attach="background" args={["#020617"]} />
      <fog attach="fog" args={["#020617", 350, 820]} />
      <ambientLight intensity={0.7} />
      <directionalLight position={[120, 220, 80]} intensity={1.2} color="#7dd3fc" />
      <directionalLight position={[-80, 140, -120]} intensity={0.5} color="#f97316" />
      <group rotation={[-0.95, 0, 0]}>
        <mesh position={[0, -4, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
          <planeGeometry args={[860, 860, 1, 1]} />
          <meshStandardMaterial color="#04141f" roughness={0.94} metalness={0.08} />
        </mesh>
        <ArenaInstancing frame={frame} />
      </group>
    </Canvas>
  );
}

function ArenaInstancing({ frame }: { frame: BinaryFrame | null }) {
  const agentMesh = useRef<InstancedMesh>(null);
  const foodMesh = useRef<InstancedMesh>(null);
  const poisonMesh = useRef<InstancedMesh>(null);
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

  useEffect(() => {
    if (!frame || !agentMesh.current || !foodMesh.current || !poisonMesh.current) {
      return;
    }

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

      agentColor.current.setRGB(shade, shade, shade + energyRatio * 0.1);
      agentTarget.setColorAt(index, agentColor.current);
    }

    for (let index = 0; index < foodLimit; index += 1) {
      const offset = index * 2;
      pointDummy.current.position.set(
        frame.food[offset] - WORLD_HALF,
        1.2,
        frame.food[offset + 1] - WORLD_HALF,
      );
      pointDummy.current.scale.setScalar(1);
      pointDummy.current.updateMatrix();
      foodTarget.setMatrixAt(index, pointDummy.current.matrix);
    }

    for (let index = 0; index < poisonLimit; index += 1) {
      const offset = index * 2;
      pointDummy.current.position.set(
        frame.poison[offset] - WORLD_HALF,
        1.1,
        frame.poison[offset + 1] - WORLD_HALF,
      );
      pointDummy.current.scale.setScalar(1);
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
  }, [frame]);

  return (
    <>
      <instancedMesh ref={agentMesh} args={[undefined, undefined, MAX_RENDERED_AGENTS]}>
        <coneGeometry args={[1.7, 4.2, 3]} />
        <meshStandardMaterial vertexColors roughness={0.35} metalness={0.12} />
      </instancedMesh>

      <instancedMesh ref={foodMesh} args={[undefined, undefined, MAX_RENDERED_POINTS]}>
        <sphereGeometry args={[1.05, 8, 8]} />
        <meshBasicMaterial color="#4ade80" />
      </instancedMesh>

      <instancedMesh ref={poisonMesh} args={[undefined, undefined, MAX_RENDERED_POINTS]}>
        <sphereGeometry args={[0.95, 8, 8]} />
        <meshBasicMaterial color="#fb7185" />
      </instancedMesh>
    </>
  );
}

function SliderField({
  label,
  value,
  min,
  max,
  step = 1,
  unit,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="font-mono text-xs uppercase tracking-[0.28em] text-slate-300">
          {label}
        </span>
        <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-sm text-white">
          {value.toLocaleString()}
          {unit ? ` ${unit}` : ""}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-2 w-full cursor-pointer appearance-none rounded-full bg-white/10 accent-cyan-400"
      />
    </label>
  );
}

function ConnectionBadge({ state }: { state: "connecting" | "live" | "offline" }) {
  const palette =
    state === "live"
      ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-200"
      : state === "connecting"
        ? "border-amber-400/40 bg-amber-400/10 text-amber-100"
        : "border-rose-400/40 bg-rose-500/10 text-rose-100";

  return (
    <div className={`rounded-full border px-4 py-3 font-mono text-xs uppercase tracking-[0.3em] ${palette}`}>
      {state === "live" ? "Binary stream live" : state}
    </div>
  );
}

function MetricCard({
  label,
  value,
  accent = "slate",
}: {
  label: string;
  value: string;
  accent?: "slate" | "emerald" | "cyan" | "amber" | "violet";
}) {
  const accentClass =
    accent === "emerald"
      ? "from-emerald-400/18 to-emerald-500/5"
      : accent === "cyan"
        ? "from-cyan-400/18 to-cyan-500/5"
        : accent === "amber"
          ? "from-amber-400/18 to-amber-500/5"
          : accent === "violet"
            ? "from-violet-400/18 to-violet-500/5"
            : "from-white/10 to-white/0";

  return (
    <div className={`glass-panel rounded-[26px] bg-gradient-to-br ${accentClass} p-4 sm:p-5`}>
      <p className="font-mono text-xs uppercase tracking-[0.28em] text-slate-400">{label}</p>
      <p className="mt-3 font-display text-2xl text-white sm:text-3xl">{value}</p>
    </div>
  );
}

function LegendBadge({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-2">
      <span className={`h-2.5 w-2.5 rounded-full ${color}`} />
      <span>{label}</span>
    </span>
  );
}

function formatMetric(value: number | undefined) {
  if (value === undefined) {
    return "0.0";
  }
  return value.toFixed(1);
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
