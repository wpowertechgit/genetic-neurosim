export type HistoryPoint = {
  generation: number;
  average_lifespan: number;
  max_fitness: number;
  average_brain_complexity: number;
};

export type StatusMetrics = {
  alive: number;
  population: number;
  average_energy: number;
  average_lifespan: number;
  max_fitness: number;
  top_fitness_ever: number;
  average_brain_complexity: number;
};

export type ControlConfig = {
  mutation_rate: number;
  population_size: number;
  max_generations: number;
  food_spawn_rate: number;
  energy_decay: number;
  tick_rate: number;
};

export type StatusResponse = {
  generation: number;
  tick: number;
  halted: boolean;
  config: ControlConfig;
  metrics: StatusMetrics;
  history: HistoryPoint[];
  session: {
    seed: number;
    replaying: boolean;
    recording_dirty: boolean;
    active_recording: string | null;
  };
};

export type RecordingSummary = {
  id: string;
  name: string;
  saved_at_ms: number;
  seed: number;
  final_generation: number;
  final_tick: number;
  population_size: number;
  max_generations: number;
};
