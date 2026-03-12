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
import { startTransition, useDeferredValue, useEffect, useRef, useState } from "react";
import { Line } from "react-chartjs-2";

import type { SimulationFrame } from "../lib/simulation-types";


ChartJS.register(CategoryScale, Filler, Legend, LineElement, LinearScale, PointElement, Tooltip);

const ARENA_SIZE = 800;
const MAX_ENERGY = 160;
const OFFLINE_FILL = "rgba(7, 19, 31, 1)";
const HEADLINE_FONT = "'Bahnschrift', 'Trebuchet MS', sans-serif";


export function NeuroSimDashboard() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const latestFrameRef = useRef<SimulationFrame | null>(null);
  const [frame, setFrame] = useState<SimulationFrame | null>(null);
  const [connectionState, setConnectionState] = useState<"connecting" | "live" | "offline">(
    "connecting",
  );
  const [messagesSeen, setMessagesSeen] = useState(0);
  const deferredHistory = useDeferredValue(frame?.history ?? []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }

    let animationFrame = 0;
    paintOfflineFrame(context);

    const render = () => {
      const nextFrame = latestFrameRef.current;
      if (nextFrame) {
        drawFrame(context, nextFrame);
      }
      animationFrame = window.requestAnimationFrame(render);
    };

    animationFrame = window.requestAnimationFrame(render);
    return () => window.cancelAnimationFrame(animationFrame);
  }, []);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let reconnectTimeout: number | null = null;
    let heartbeatInterval: number | null = null;
    let cancelled = false;

    const connect = () => {
      setConnectionState("connecting");
      socket = new WebSocket(resolveSimulationSocket());

      socket.onopen = () => {
        setConnectionState("live");
        heartbeatInterval = window.setInterval(() => {
          if (socket?.readyState === WebSocket.OPEN) {
            socket.send("ping");
          }
        }, 10_000);
      };

      socket.onmessage = (event) => {
        const incomingFrame = JSON.parse(event.data) as SimulationFrame;
        latestFrameRef.current = incomingFrame;
        startTransition(() => {
          setFrame(incomingFrame);
          setMessagesSeen((value) => value + 1);
        });
      };

      socket.onerror = () => {
        socket?.close();
      };

      socket.onclose = () => {
        if (heartbeatInterval !== null) {
          window.clearInterval(heartbeatInterval);
        }
        if (cancelled) {
          return;
        }
        setConnectionState("offline");
        reconnectTimeout = window.setTimeout(connect, 1_500);
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimeout !== null) {
        window.clearTimeout(reconnectTimeout);
      }
      if (heartbeatInterval !== null) {
        window.clearInterval(heartbeatInterval);
      }
      socket?.close();
    };
  }, []);

  const stats = frame?.stats;
  const chartData = {
    labels: deferredHistory.map((entry) => `G${entry.generation}`),
    datasets: [
      {
        label: "Average Lifespan",
        data: deferredHistory.map((entry) => entry.average_lifespan),
        borderColor: "#0b6e4f",
        backgroundColor: "rgba(11, 110, 79, 0.14)",
        borderWidth: 2,
        fill: true,
        pointRadius: 0,
        tension: 0.28,
      },
      {
        label: "Max Fitness",
        data: deferredHistory.map((entry) => entry.max_fitness),
        borderColor: "#cf4b5a",
        backgroundColor: "rgba(207, 75, 90, 0.08)",
        borderWidth: 2,
        fill: false,
        pointRadius: 0,
        tension: 0.25,
      },
    ],
  };

  const chartOptions: ChartOptions<"line"> = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: {
      mode: "index" as const,
      intersect: false,
    },
    plugins: {
      legend: {
        labels: {
          color: "#163245",
          font: {
            family: HEADLINE_FONT,
          },
        },
      },
      tooltip: {
        backgroundColor: "#092332",
        titleColor: "#f5efdf",
        bodyColor: "#f5efdf",
      },
    },
    scales: {
      x: {
        ticks: {
          color: "#476071",
          maxTicksLimit: 10,
        },
        grid: {
          color: "rgba(22, 50, 69, 0.1)",
        },
      },
      y: {
        ticks: {
          color: "#476071",
        },
        grid: {
          color: "rgba(22, 50, 69, 0.1)",
        },
      },
    },
  };

  return (
    <main className="dashboard-shell">
      <section className="hero-panel">
        <div className="eyebrow">NeuroSim / Darwin Arena</div>
        <div className="hero-grid">
          <div>
            <h1>Evolutionary neural agents learning live in a hostile arena.</h1>
            <p className="hero-copy">
              Each organism runs a tiny NumPy-built neural network. Every generation keeps the
              longest-lived survivors, crosses their weights, mutates the offspring, and sends the
              next swarm back into the ecosystem.
            </p>
          </div>
          <div className="hero-meta">
            <div className={`status-pill status-${connectionState}`}>
              <span className="status-dot" />
              {connectionState === "live" ? "WebSocket live" : connectionState}
            </div>
            <div className="metric-chip">
              <span>Frames seen</span>
              <strong>{messagesSeen}</strong>
            </div>
            <div className="metric-chip">
              <span>Current generation</span>
              <strong>{frame?.generation ?? 1}</strong>
            </div>
          </div>
        </div>
      </section>

      <section className="arena-layout">
        <article className="arena-panel">
          <div className="panel-header">
            <div>
              <span className="panel-label">Simulation Arena</span>
              <h2>800 x 800 toroidal ecosystem</h2>
            </div>
            <div className="legend-row">
              <span className="legend-item legend-food">Food</span>
              <span className="legend-item legend-poison">Poison</span>
              <span className="legend-item legend-agent">Agents</span>
            </div>
          </div>
          <div className="canvas-frame">
            <canvas ref={canvasRef} width={ARENA_SIZE} height={ARENA_SIZE} className="arena-canvas" />
          </div>
        </article>

        <aside className="sidebar-panel">
          <div className="stats-grid">
            <StatCard label="Alive now" value={stats?.alive ?? 0} accent="green" />
            <StatCard label="Population" value={stats?.population ?? 0} accent="neutral" />
            <StatCard label="Avg energy" value={formatNumber(stats?.average_energy)} accent="blue" />
            <StatCard
              label="Best fitness ever"
              value={formatNumber(stats?.top_fitness_ever)}
              accent="red"
            />
          </div>

          <div className="insight-card">
            <span className="panel-label">Generation Notes</span>
            <p>
              Agents brighten as their energy rises and fade toward charcoal when starving. The
              soft canvas wash leaves movement trails behind each organism so direction shifts and
              emergent swarms are visible at a glance.
            </p>
          </div>

          <div className="insight-card">
            <span className="panel-label">Selection Pressure</span>
            <p>
              The backend selects the top 10% longest-lived organisms, recombines their neural
              weights, mutates 5% of the genes, and restarts the arena when the population goes
              extinct.
            </p>
          </div>
        </aside>
      </section>

      <section className="chart-panel">
        <div className="panel-header">
          <div>
            <span className="panel-label">Evolution Analytics</span>
            <h2>Lifespan and fitness over generations</h2>
          </div>
        </div>
        <div className="chart-wrap">
          <Line data={chartData} options={chartOptions} />
        </div>
      </section>
    </main>
  );
}


function StatCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: string | number;
  accent: "green" | "neutral" | "blue" | "red";
}) {
  return (
    <div className={`stat-card stat-${accent}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}


function resolveSimulationSocket() {
  const configuredUrl = process.env.NEXT_PUBLIC_SIM_WS_URL;
  if (configuredUrl) {
    return configuredUrl;
  }

  if (typeof window === "undefined") {
    return "ws://127.0.0.1:8000/ws/simulation";
  }

  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${window.location.hostname}:8000/ws/simulation`;
}


function drawFrame(context: CanvasRenderingContext2D, frame: SimulationFrame) {
  context.save();
  context.fillStyle = "rgba(7, 19, 31, 0.18)";
  context.fillRect(0, 0, ARENA_SIZE, ARENA_SIZE);

  context.strokeStyle = "rgba(160, 187, 204, 0.08)";
  context.lineWidth = 1;
  for (let step = 80; step < ARENA_SIZE; step += 80) {
    context.beginPath();
    context.moveTo(step, 0);
    context.lineTo(step, ARENA_SIZE);
    context.stroke();
    context.beginPath();
    context.moveTo(0, step);
    context.lineTo(ARENA_SIZE, step);
    context.stroke();
  }

  for (const point of frame.food) {
    drawGlow(context, point.x, point.y, 5, "#59d98e", "rgba(89, 217, 142, 0.35)");
  }

  for (const point of frame.poison) {
    drawGlow(context, point.x, point.y, 5, "#ff4d5f", "rgba(255, 77, 95, 0.32)");
  }

  for (const agent of frame.agents) {
    drawAgent(context, agent.x, agent.y, agent.angle, agent.energy);
  }
  context.restore();
}


function paintOfflineFrame(context: CanvasRenderingContext2D) {
  context.save();
  context.fillStyle = OFFLINE_FILL;
  context.fillRect(0, 0, ARENA_SIZE, ARENA_SIZE);
  context.fillStyle = "rgba(245, 239, 223, 0.8)";
  context.font = `500 24px ${HEADLINE_FONT}`;
  context.fillText("Awaiting simulation stream...", 240, 390);
  context.restore();
}


function drawGlow(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  solidColor: string,
  glowColor: string,
) {
  context.save();
  context.beginPath();
  context.fillStyle = solidColor;
  context.shadowBlur = 18;
  context.shadowColor = glowColor;
  context.arc(x, y, radius, 0, Math.PI * 2);
  context.fill();
  context.restore();
}


function drawAgent(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  angle: number,
  energy: number,
) {
  const energyRatio = Math.max(0.15, Math.min(1, energy / MAX_ENERGY));
  const shade = Math.round(70 + energyRatio * 185);
  const accent = Math.round(80 + energyRatio * 140);

  context.save();
  context.translate(x, y);
  context.rotate(angle);
  context.beginPath();
  context.moveTo(11, 0);
  context.lineTo(-8, 6);
  context.lineTo(-4, 0);
  context.lineTo(-8, -6);
  context.closePath();
  context.fillStyle = `rgb(${shade}, ${shade}, ${shade})`;
  context.shadowBlur = 14;
  context.shadowColor = `rgba(${accent}, ${accent}, ${accent}, 0.32)`;
  context.fill();
  context.restore();
}


function formatNumber(value: number | undefined) {
  if (value === undefined) {
    return "0";
  }
  return value.toFixed(1);
}
