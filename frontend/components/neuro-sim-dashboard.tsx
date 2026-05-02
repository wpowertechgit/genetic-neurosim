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
import { OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
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
const LIVE_SERIES_LIMIT = 160;

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

type PanelState = {
  controls: boolean;
  analytics: boolean;
  sessions: boolean;
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
  const [actionMessage, setActionMessage] = useState("Use the controls panel to tune the run.");
  const [isBusy, setIsBusy] = useState(false);
  const [analyticsMode, setAnalyticsMode] = useState<"live" | "generations">("live");
  const [cameraResetVersion, setCameraResetVersion] = useState(0);
  const [panels, setPanels] = useState<PanelState>({
    controls: true,
    analytics: true,
    sessions: true,
  });
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
      // silence
    }
  });

  const handleBinaryFrame = useEffectEvent((payload: ArrayBuffer) => {
    const parsed = parseBinaryFrame(payload);
    latestFrameRef.current = parsed;
    frameRevisionRef.current += 1;
    uiUpdateCounterRef.current += 1;

    if (uiUpdateCounterRef.current % 4 === 0) {
      startTransition(() => {
        setOverlayStats({
          generation: parsed.generation,
          tick: parsed.tick,
          agentCount: parsed.agentCount,
          topFitness: parsed.topFitness,
          averageComplexity: parsed.averageComplexity,
          averageLifespan: parsed.averageLifespan,
          halted: parsed.halted,
        });
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
  }, []);

  useEffect(() => {
    fetchStatus();
    fetchRecordings();
    const statusInterval = window.setInterval(fetchStatus, 1000);
    const recordingInterval = window.setInterval(fetchRecordings, 4000);
    return () => {
      window.clearInterval(statusInterval);
      window.clearInterval(recordingInterval);
    };
  }, []);

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
      setActionMessage("Config applied to the running simulation.");
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
      setActionMessage(`Saved session "${saved.name}".`);
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
    setActionMessage("Forcing a population bottleneck...");

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
        borderColor: "#f0f0fa",
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.16,
      },
      {
        label: "Top Fitness",
        data: liveSeries.map((point) => point.topFitness),
        borderColor: "rgba(240,240,250,0.55)",
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.16,
      },
      {
        label: "Complexity",
        data: liveSeries.map((point) => point.complexity),
        borderColor: "rgba(240,240,250,0.25)",
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.16,
      },
    ],
  };

  const generationChartData = {
    labels: deferredHistory.map((point) => `G${point.generation}`),
    datasets: [
      {
        label: "Average Lifespan",
        data: deferredHistory.map((point) => point.average_lifespan),
        borderColor: "#f0f0fa",
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.18,
      },
      {
        label: "Max Fitness",
        data: deferredHistory.map((point) => point.max_fitness),
        borderColor: "rgba(240,240,250,0.55)",
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.18,
      },
      {
        label: "Brain Complexity",
        data: deferredHistory.map((point) => point.average_brain_complexity),
        borderColor: "rgba(240,240,250,0.25)",
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.18,
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
          color: "rgba(240,240,250,0.7)",
          font: { family: "Barlow, D-DIN, Arial", size: 11 },
        },
      },
      tooltip: {
        backgroundColor: "#000000",
        titleColor: "#f0f0fa",
        bodyColor: "rgba(240,240,250,0.7)",
        borderColor: "rgba(240,240,250,0.2)",
        borderWidth: 1,
      },
    },
    scales: {
      x: {
        ticks: {
          color: "rgba(240,240,250,0.35)",
          maxTicksLimit: 8,
          font: { family: "Barlow, D-DIN, Arial", size: 10 },
        },
        grid: {
          color: "rgba(240,240,250,0.06)",
        },
      },
      y: {
        ticks: {
          color: "rgba(240,240,250,0.35)",
          font: { family: "Barlow, D-DIN, Arial", size: 10 },
        },
        grid: {
          color: "rgba(240,240,250,0.06)",
        },
      },
    },
  };

  const togglePanel = (panel: keyof PanelState) => {
    setPanels((current) => ({ ...current, [panel]: !current[panel] }));
  };

  return (
    <main className="h-screen w-screen overflow-hidden bg-black text-[#f0f0fa]">
      <div className="relative h-full w-full">
        <SimulationViewport
          frameRef={latestFrameRef}
          revisionRef={frameRevisionRef}
          halted={overlayStats.halted}
          resetVersion={cameraResetVersion}
        />

        <Toolbar className="left-1/2 top-4 -translate-x-1/2">
          <GhostButton
            label={panels.controls ? "Hide Controls" : "Show Controls"}
            onClick={() => togglePanel("controls")}
            active={panels.controls}
          />
          <GhostButton
            label={panels.analytics ? "Hide Analytics" : "Show Analytics"}
            onClick={() => togglePanel("analytics")}
            active={panels.analytics}
          />
          <GhostButton
            label={panels.sessions ? "Hide Sessions" : "Show Sessions"}
            onClick={() => togglePanel("sessions")}
            active={panels.sessions}
          />
          <GhostButton
            label="Reset View"
            onClick={() => setCameraResetVersion((value) => value + 1)}
          />
        </Toolbar>

        <OverlayPanel className="left-4 top-4 w-[320px]">
          <p className="text-[10px] uppercase tracking-[1px] text-[rgba(240,240,250,0.4)] leading-[0.94]">
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
          <div className="mt-4 flex items-center justify-between text-[10px] uppercase tracking-[1px] text-[rgba(240,240,250,0.35)]">
            <span>{connectionState === "live" ? "streaming" : connectionState}</span>
            <span>{status?.session.replaying ? "replay mode" : "live mode"}</span>
          </div>
          <p className="mt-3 text-[12px] uppercase tracking-[0.5px] text-[rgba(240,240,250,0.5)]">
            {actionMessage}
          </p>
          <p className="mt-3 text-[10px] uppercase tracking-[0.5px] text-[rgba(240,240,250,0.2)]">
            Drag to orbit. Right-drag to pan. Scroll to zoom.
          </p>
        </OverlayPanel>

        {panels.controls ? (
          <OverlayPanel className="right-4 top-4 w-[380px]">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-[10px] uppercase tracking-[1px] text-[rgba(240,240,250,0.4)] leading-[0.94]">
                  Configuration
                </p>
                <h2 className="mt-2 text-[28px] font-bold uppercase tracking-[0.96px] text-[#f0f0fa] leading-[1]">
                  Run Controls
                </h2>
              </div>
              <div className="border border-[rgba(240,240,250,0.2)] px-3 py-2 text-[10px] uppercase tracking-[1px] text-[rgba(240,240,250,0.4)]">
                Seed {status?.session.seed ?? 7}
              </div>
            </div>

            <div className="mt-5 max-h-[calc(100vh-12rem)] space-y-4 overflow-y-auto pr-1">
              <RangeField
                label="Mutation Severity"
                value={form.mutationSeverity}
                min={0}
                max={100}
                unit="%"
                onChange={(value) =>
                  setForm((current) => ({ ...current, mutationSeverity: value }))
                }
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
                onChange={(value) =>
                  setForm((current) => ({ ...current, targetPopulation: value }))
                }
              />
              <NumberField
                label="Generations"
                value={form.maxGenerations}
                min={1}
                max={5000}
                onChange={(value) =>
                  setForm((current) => ({ ...current, maxGenerations: value }))
                }
              />
              <label className="block">
                <div className="mb-2 text-[11px] uppercase tracking-[0.96px] text-[rgba(240,240,250,0.5)]">
                  Offline Session Name
                </div>
                <input
                  type="text"
                  value={form.sessionName}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, sessionName: event.target.value }))
                  }
                  placeholder="e.g. bottleneck-test-01"
                  className="w-full border-b border-[rgba(240,240,250,0.2)] bg-transparent px-0 py-2 text-[12px] uppercase tracking-[0.5px] text-[#f0f0fa] outline-none placeholder:text-[rgba(240,240,250,0.2)] focus:border-[rgba(240,240,250,0.5)]"
                />
              </label>
              <p className="text-[11px] uppercase tracking-[0.5px] text-[rgba(240,240,250,0.3)]">
                Apply changes to the running simulation. Save session stores data for offline replay.
              </p>
            </div>

            <div className="mt-5 grid grid-cols-2 gap-3">
              <GhostButton label="Apply Changes" onClick={applyConfig} disabled={isBusy} />
              <GhostButton label="God Mode" onClick={triggerGodMode} disabled={isBusy} />
              <GhostButton label="Save Session" onClick={saveRecording} disabled={isBusy} />
              <GhostButton
                label={status?.session.recording_dirty ? "Unsaved Changes" : "Session Saved"}
                onClick={saveRecording}
                disabled={isBusy || !status?.session.recording_dirty}
              />
            </div>
          </OverlayPanel>
        ) : null}

        {panels.analytics ? (
          <OverlayPanel className="bottom-4 right-4 h-[420px] w-[760px] max-w-[calc(100vw-2rem)]">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-[10px] uppercase tracking-[1px] text-[rgba(240,240,250,0.4)] leading-[0.94]">
                  Analytics
                </p>
                <h2 className="mt-2 text-[28px] font-bold uppercase tracking-[0.96px] text-[#f0f0fa] leading-[1]">
                  Explore The Run
                </h2>
              </div>
              <div className="flex gap-2">
                <GhostButton
                  label="Live Graph"
                  onClick={() => setAnalyticsMode("live")}
                  active={analyticsMode === "live"}
                />
                <GhostButton
                  label="Generation History"
                  onClick={() => setAnalyticsMode("generations")}
                  active={analyticsMode === "generations"}
                />
              </div>
            </div>

            <div className="mt-4 grid h-[320px] gap-4 lg:grid-cols-[minmax(0,1fr)_220px]">
              <div className="border border-[rgba(240,240,250,0.1)] bg-black/40 p-3">
                <Line
                  data={analyticsMode === "live" ? liveChartData : generationChartData}
                  options={chartOptions}
                />
              </div>
              <div className="border border-[rgba(240,240,250,0.1)] bg-black/40 p-4">
                {analyticsMode === "live" ? (
                  <>
                    <div className="text-[11px] font-bold uppercase tracking-[1.17px] text-[#f0f0fa]">
                      Live Window
                    </div>
                    <div className="mt-3 space-y-3">
                      <MetricRow
                        label="Current alive"
                        value={overlayStats.agentCount.toLocaleString()}
                      />
                      <MetricRow
                        label="Top fitness"
                        value={overlayStats.topFitness.toFixed(1)}
                      />
                      <MetricRow
                        label="Brain complexity"
                        value={overlayStats.averageComplexity.toFixed(1)}
                      />
                      <MetricRow
                        label="Avg lifespan"
                        value={overlayStats.averageLifespan.toFixed(1)}
                      />
                      <MetricRow label="Ticks tracked" value={liveSeries.length.toString()} />
                    </div>
                  </>
                ) : (
                  <>
                    <div className="text-[11px] font-bold uppercase tracking-[1.17px] text-[#f0f0fa]">
                      Recent Generations
                    </div>
                    <div className="mt-3 max-h-[250px] space-y-2 overflow-auto pr-1">
                      {deferredHistory.slice(-10).reverse().map((entry) => (
                        <div
                          key={entry.generation}
                          className="border-b border-[rgba(240,240,250,0.1)] pb-2"
                        >
                          <div className="text-[11px] font-bold uppercase tracking-[1.17px] text-[#f0f0fa]">
                            Generation {entry.generation}
                          </div>
                          <div className="mt-1 text-[10px] uppercase tracking-[0.5px] text-[rgba(240,240,250,0.4)]">
                            Lifespan {entry.average_lifespan.toFixed(1)} / Fitness{" "}
                            {entry.max_fitness.toFixed(1)} / Complexity{" "}
                            {entry.average_brain_complexity.toFixed(1)}
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>
          </OverlayPanel>
        ) : null}

        {panels.sessions ? (
          <OverlayPanel className="bottom-4 left-4 w-[440px] max-w-[calc(100vw-2rem)]">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-[10px] uppercase tracking-[1px] text-[rgba(240,240,250,0.4)] leading-[0.94]">
                  Offline Replay
                </p>
                <h2 className="mt-2 text-[28px] font-bold uppercase tracking-[0.96px] text-[#f0f0fa] leading-[1]">
                  Saved Sessions
                </h2>
              </div>
              <span className="text-[10px] uppercase tracking-[1px] text-[rgba(240,240,250,0.35)]">
                {recordings.length} stored
              </span>
            </div>

            <div className="mt-4 max-h-[260px] space-y-2 overflow-auto pr-1">
              {recordings.length === 0 ? (
                <p className="text-[11px] uppercase tracking-[0.5px] text-[rgba(240,240,250,0.3)]">
                  Save the current run, then replay it later from here.
                </p>
              ) : (
                recordings.map((recording) => (
                  <button
                    key={recording.id}
                    type="button"
                    onClick={() => replayRecording(recording.id)}
                    className="w-full border border-[rgba(240,240,250,0.15)] bg-[rgba(240,240,250,0.04)] px-4 py-3 text-left transition hover:border-[rgba(240,240,250,0.35)] hover:bg-[rgba(240,240,250,0.08)] disabled:opacity-40"
                    disabled={isBusy}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-[11px] font-bold uppercase tracking-[1.17px] text-[#f0f0fa]">
                          {recording.name}
                        </div>
                        <div className="mt-1 text-[10px] uppercase tracking-[0.5px] text-[rgba(240,240,250,0.4)]">
                          Gen {recording.final_generation}, Tick {recording.final_tick}
                        </div>
                      </div>
                      <div className="text-right text-[10px] uppercase tracking-[0.5px] text-[rgba(240,240,250,0.35)]">
                        <div>{recording.population_size.toLocaleString()} agents</div>
                        <div>{new Date(recording.saved_at_ms).toLocaleString()}</div>
                      </div>
                    </div>
                  </button>
                ))
              )}
            </div>
          </OverlayPanel>
        ) : null}
      </div>
    </main>
  );
}

function SimulationViewport({
  frameRef,
  revisionRef,
  halted,
  resetVersion,
}: {
  frameRef: MutableRefObject<BinaryFrame | null>;
  revisionRef: MutableRefObject<number>;
  halted: boolean;
  resetVersion: number;
}) {
  return (
    <Canvas camera={{ position: [0, 320, 320], fov: 48 }}>
      <color attach="background" args={["#000000"]} />
      <ambientLight intensity={0.55} />
      <directionalLight position={[80, 180, 90]} intensity={1.0} color="#ffffff" />
      <SceneControls resetVersion={resetVersion} />
      <group rotation={[-0.95, 0, 0]}>
        <mesh position={[0, -4, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[860, 860, 1, 1]} />
          <meshStandardMaterial
            color={halted ? "#0a0a0a" : "#070707"}
            roughness={1}
            metalness={0}
          />
        </mesh>
        <ArenaInstancing frameRef={frameRef} revisionRef={revisionRef} />
      </group>
    </Canvas>
  );
}

function SceneControls({ resetVersion }: { resetVersion: number }) {
  const controlsRef = useRef<any>(null);
  const { camera } = useThree();

  useEffect(() => {
    camera.position.set(0, 320, 320);
    if (controlsRef.current) {
      controlsRef.current.target.set(0, 0, 0);
      controlsRef.current.update();
    }
  }, [camera, resetVersion]);

  return (
    <OrbitControls
      ref={controlsRef}
      enablePan
      enableZoom
      enableRotate
      maxDistance={900}
      minDistance={80}
      target={[0, 0, 0]}
    />
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
      const offset = index * 5;
      const x = frame.agents[offset] - WORLD_HALF;
      const z = frame.agents[offset + 1] - WORLD_HALF;
      const energy = frame.agents[offset + 2];
      const angle = frame.agents[offset + 3];
      const clusterId = frame.agents[offset + 4];
      const energyRatio = Math.max(0.12, Math.min(1, energy / 200));
      const shade = 0.18 + energyRatio * 0.82;

      agentDummy.current.position.set(x, 2.2, z);
      agentDummy.current.rotation.set(Math.PI / 2, angle, 0);
      agentDummy.current.scale.setScalar(energyRatio * 1.05 + 0.55);
      agentDummy.current.updateMatrix();
      agentTarget.setMatrixAt(index, agentDummy.current.matrix);

      if (clusterId > 0) {
        const hue = (clusterId * 137.5) % 360;
        agentColor.current.setHSL(hue / 360, 0.8, 0.5 + energyRatio * 0.2);
      } else {
        agentColor.current.setRGB(shade, shade, shade);
      }
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
        <meshBasicMaterial color="#f0f0fa" />
      </instancedMesh>

      <instancedMesh ref={poisonMesh} args={[undefined, undefined, MAX_RENDERED_POINTS]}>
        <sphereGeometry args={[0.85, 6, 6]} />
        <meshBasicMaterial color="rgba(240,240,250,0.25)" />
      </instancedMesh>
    </>
  );
}

function Toolbar({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`absolute z-20 flex gap-2 p-2 ${className ?? ""}`}
      style={{
        background: "rgba(0,0,0,0.5)",
        border: "1px solid rgba(240,240,250,0.15)",
        backdropFilter: "blur(4px)",
      }}
    >
      {children}
    </div>
  );
}

function GhostButton({
  label,
  onClick,
  active = false,
  disabled = false,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-[32px] px-[18px] py-2 text-[13px] font-bold uppercase tracking-[1.17px] text-[#f0f0fa] transition disabled:cursor-not-allowed disabled:opacity-30"
      style={{
        background: active ? "rgba(240,240,250,0.2)" : "rgba(240,240,250,0.1)",
        border: active
          ? "1px solid rgba(240,240,250,0.55)"
          : "1px solid rgba(240,240,250,0.35)",
      }}
      onMouseEnter={(e) => {
        if (!disabled) {
          (e.currentTarget as HTMLButtonElement).style.background = "rgba(240,240,250,0.18)";
          (e.currentTarget as HTMLButtonElement).style.borderColor = "rgba(240,240,250,0.55)";
        }
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = active
          ? "rgba(240,240,250,0.2)"
          : "rgba(240,240,250,0.1)";
        (e.currentTarget as HTMLButtonElement).style.borderColor = active
          ? "rgba(240,240,250,0.55)"
          : "rgba(240,240,250,0.35)";
      }}
    >
      {label}
    </button>
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
      className={`absolute p-4 ${className}`}
      style={{
        background: "rgba(0,0,0,0.6)",
        border: "1px solid rgba(240,240,250,0.12)",
        backdropFilter: "blur(3px)",
      }}
    >
      {children}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[1px] text-[rgba(240,240,250,0.4)] leading-[0.94]">
        {label}
      </div>
      <div className="mt-2 text-[18px] font-bold uppercase tracking-[0.96px] text-[#f0f0fa] leading-[1]">
        {value}
      </div>
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
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-[0.96px] text-[rgba(240,240,250,0.6)]">
          {label}
        </span>
        <span className="font-mono text-[11px] text-[rgba(240,240,250,0.4)]">
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
        className="h-[1px] w-full cursor-pointer appearance-none bg-[rgba(240,240,250,0.2)] accent-[#f0f0fa]"
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
      <div className="mb-2 text-[11px] uppercase tracking-[0.96px] text-[rgba(240,240,250,0.6)]">
        {label}
      </div>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="w-full border-b border-[rgba(240,240,250,0.2)] bg-transparent px-0 py-2 text-[12px] uppercase tracking-[0.5px] text-[#f0f0fa] outline-none focus:border-[rgba(240,240,250,0.5)]"
      />
    </label>
  );
}

function MetricRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[10px] uppercase tracking-[0.5px] text-[rgba(240,240,250,0.4)]">
        {label}
      </span>
      <span className="text-[11px] font-bold uppercase tracking-[0.96px] text-[#f0f0fa]">
        {value}
      </span>
    </div>
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
