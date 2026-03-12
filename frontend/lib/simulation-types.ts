export type ConsumableSnapshot = {
  x: number;
  y: number;
};

export type AgentSnapshot = {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  energy: number;
  age: number;
  fitness: number;
};

export type GenerationHistoryPoint = {
  generation: number;
  average_lifespan: number;
  max_fitness: number;
};

export type SimulationStats = {
  alive: number;
  population: number;
  average_energy: number;
  average_lifespan: number;
  max_fitness: number;
  top_fitness_ever: number;
};

export type SimulationFrame = {
  tick: number;
  generation: number;
  agents: AgentSnapshot[];
  food: ConsumableSnapshot[];
  poison: ConsumableSnapshot[];
  stats: SimulationStats;
  history: GenerationHistoryPoint[];
};
