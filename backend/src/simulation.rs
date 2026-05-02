use std::{
    cmp::Ordering,
    collections::{HashMap, HashSet},
    fs,
    path::PathBuf,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use parking_lot::RwLock;
use rand::{prelude::IndexedRandom, rngs::SmallRng, seq::SliceRandom, Rng, SeedableRng};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};

pub type SharedSimulation = Arc<RwLock<Simulation>>;

const WORLD_WIDTH: f32 = 800.0;
const WORLD_HEIGHT: f32 = 800.0;
const WORLD_DIAGONAL: f32 = 1131.3708;
const INPUT_COUNT: usize = 5;
const OUTPUT_COUNT: usize = 2;
const BASE_ENERGY: f32 = 120.0;
const MAX_ENERGY: f32 = 200.0;
const MAX_SPEED: f32 = 6.6;
const TURN_RATE: f32 = 0.28;
const THRUST: f32 = 0.48;
const DRAG: f32 = 0.92;
const FOOD_ENERGY: f32 = 26.0;
const POISON_DAMAGE: f32 = 42.0;
const COLLISION_RADIUS: f32 = 12.0;
const HASH_CELL_SIZE: f32 = 32.0;
const HISTORY_LIMIT: usize = 240;
const RECORDINGS_DIR: &str = "recordings";

#[derive(Clone, Serialize, Deserialize)]
pub struct ControlConfig {
    pub mutation_rate: f32,
    pub population_size: usize,
    pub max_generations: u32,
    pub food_spawn_rate: u32,
    pub energy_decay: f32,
    pub tick_rate: u32,
    pub clusters: Vec<ClusterProfile>,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct ClusterProfile {
    pub id: String,
    pub size_ratio: f32,              // 0.0 - 1.0 (portion of total population_size)
    pub mean_opscore: f32,            // Maps to baseline brain effectiveness/complexity
    pub opscore_stddev: f32,          // Maps to initial genome variance
    pub cohesion: f32,                // Maps to mutation resistance or coordination
    pub internal_edge_ratio: f32,     // Maps to persistence/stability
}

impl Default for ControlConfig {
    fn default() -> Self {
        Self {
            mutation_rate: 0.12,
            population_size: 2_500,
            max_generations: 80,
            food_spawn_rate: 24,
            energy_decay: 0.82,
            tick_rate: 30,
            clusters: Vec::new(),
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct ConfigPatch {
    pub mutation_rate: Option<f32>,
    pub population_size: Option<usize>,
    pub max_generations: Option<u32>,
    pub food_spawn_rate: Option<u32>,
    pub energy_decay: Option<f32>,
    pub tick_rate: Option<u32>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct HistoryPoint {
    pub generation: u32,
    pub average_lifespan: f32,
    pub max_fitness: f32,
    pub average_brain_complexity: f32,
}

#[derive(Clone, Serialize)]
pub struct StatusMetrics {
    pub alive: usize,
    pub population: usize,
    pub average_energy: f32,
    pub average_lifespan: f32,
    pub max_fitness: f32,
    pub top_fitness_ever: f32,
    pub average_brain_complexity: f32,
}

#[derive(Clone, Serialize)]
pub struct StatusResponse {
    pub generation: u32,
    pub tick: u64,
    pub halted: bool,
    pub config: ControlConfig,
    pub metrics: StatusMetrics,
    pub history: Vec<HistoryPoint>,
    pub session: SessionState,
}

#[derive(Clone, Serialize)]
pub struct GodModeResponse {
    pub removed_agents: usize,
    pub alive_after: usize,
}

#[derive(Clone, Serialize)]
pub struct SessionState {
    pub seed: u64,
    pub replaying: bool,
    pub recording_dirty: bool,
    pub active_recording: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct SaveRecordingRequest {
    pub name: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct ReplayRecordingRequest {
    pub recording_id: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct RecordingSummary {
    pub id: String,
    pub name: String,
    pub saved_at_ms: u64,
    pub seed: u64,
    pub final_generation: u32,
    pub final_tick: u64,
    pub population_size: usize,
    pub max_generations: u32,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum RecordedAction {
    ConfigPatch { patch: ConfigPatch },
    GodMode,
}

#[derive(Clone, Serialize, Deserialize)]
struct RecordedEvent {
    tick: u64,
    #[serde(flatten)]
    action: RecordedAction,
}

#[derive(Clone, Serialize, Deserialize)]
struct RecordingFile {
    summary: RecordingSummary,
    initial_config: ControlConfig,
    final_config: ControlConfig,
    history: Vec<HistoryPoint>,
    events: Vec<RecordedEvent>,
}

#[derive(Clone)]
struct ReplayState {
    recording_id: String,
    events: Vec<RecordedEvent>,
    next_event_index: usize,
    final_tick: u64,
}

#[derive(Clone, Copy, Default)]
struct Vec2 {
    x: f32,
    y: f32,
}

impl Vec2 {
    fn new(x: f32, y: f32) -> Self {
        Self { x, y }
    }

    fn from_angle(angle: f32) -> Self {
        Self {
            x: angle.cos(),
            y: angle.sin(),
        }
    }

    fn length(self) -> f32 {
        (self.x * self.x + self.y * self.y).sqrt()
    }

    fn wrapped(mut self) -> Self {
        if self.x < 0.0 {
            self.x += WORLD_WIDTH;
        } else if self.x >= WORLD_WIDTH {
            self.x -= WORLD_WIDTH;
        }
        if self.y < 0.0 {
            self.y += WORLD_HEIGHT;
        } else if self.y >= WORLD_HEIGHT {
            self.y -= WORLD_HEIGHT;
        }
        self
    }
}

impl std::ops::Add for Vec2 {
    type Output = Vec2;

    fn add(self, rhs: Self) -> Self::Output {
        Vec2::new(self.x + rhs.x, self.y + rhs.y)
    }
}

impl std::ops::Mul<f32> for Vec2 {
    type Output = Vec2;

    fn mul(self, rhs: f32) -> Self::Output {
        Vec2::new(self.x * rhs, self.y * rhs)
    }
}

fn toroidal_delta(origin: Vec2, target: Vec2) -> Vec2 {
    let mut dx = target.x - origin.x;
    let mut dy = target.y - origin.y;

    if dx.abs() > WORLD_WIDTH * 0.5 {
        dx -= WORLD_WIDTH.copysign(dx);
    }
    if dy.abs() > WORLD_HEIGHT * 0.5 {
        dy -= WORLD_HEIGHT.copysign(dy);
    }

    Vec2::new(dx, dy)
}

fn signed_angle(heading: Vec2, delta: Vec2) -> f32 {
    let length = delta.length();
    if length < 1e-5 {
        return 0.0;
    }

    let target = Vec2::new(delta.x / length, delta.y / length);
    let dot = (heading.x * target.x + heading.y * target.y).clamp(-1.0, 1.0);
    let determinant = heading.x * target.y - heading.y * target.x;
    determinant.atan2(dot)
}

#[derive(Clone)]
struct SpatialHash {
    cell_size: f32,
    cols: usize,
    rows: usize,
    buckets: Vec<Vec<usize>>,
}

impl SpatialHash {
    fn new(cell_size: f32) -> Self {
        let cols = (WORLD_WIDTH / cell_size).ceil() as usize;
        let rows = (WORLD_HEIGHT / cell_size).ceil() as usize;
        Self {
            cell_size,
            cols,
            rows,
            buckets: vec![Vec::new(); cols * rows],
        }
    }

    fn rebuild(&mut self, items: &[Vec2]) {
        for bucket in &mut self.buckets {
            bucket.clear();
        }
        for (index, item) in items.iter().enumerate() {
            let cell = self.cell(item);
            self.buckets[cell].push(index);
        }
    }

    fn cell(&self, point: &Vec2) -> usize {
        let x =
            ((point.x / self.cell_size).floor() as isize).rem_euclid(self.cols as isize) as usize;
        let y =
            ((point.y / self.cell_size).floor() as isize).rem_euclid(self.rows as isize) as usize;
        y * self.cols + x
    }

    fn nearest_sensor(&self, origin: Vec2, heading_angle: f32, items: &[Vec2]) -> (f32, f32) {
        if items.is_empty() {
            return (1.0, 0.0);
        }

        let base_x = ((origin.x / self.cell_size).floor() as isize).rem_euclid(self.cols as isize);
        let base_y = ((origin.y / self.cell_size).floor() as isize).rem_euclid(self.rows as isize);

        let mut best_delta = Vec2::default();
        let mut best_distance_sq = f32::MAX;
        let max_radius = self.cols.max(self.rows) as isize;

        for radius in 0..=max_radius {
            let mut found_any = false;
            for dx in -radius..=radius {
                for dy in -radius..=radius {
                    if radius > 0 && dx.abs() < radius && dy.abs() < radius {
                        continue;
                    }
                    let x = (base_x + dx).rem_euclid(self.cols as isize) as usize;
                    let y = (base_y + dy).rem_euclid(self.rows as isize) as usize;
                    let bucket = &self.buckets[y * self.cols + x];
                    if bucket.is_empty() {
                        continue;
                    }
                    found_any = true;
                    for &item_index in bucket {
                        let delta = toroidal_delta(origin, items[item_index]);
                        let distance_sq = delta.x * delta.x + delta.y * delta.y;
                        if distance_sq < best_distance_sq {
                            best_distance_sq = distance_sq;
                            best_delta = delta;
                        }
                    }
                }
            }

            if best_distance_sq < f32::MAX {
                let search_radius = (radius as f32 + 1.0) * self.cell_size;
                if search_radius * search_radius > best_distance_sq {
                    break;
                }
            }
            if radius > 2 && !found_any && best_distance_sq < f32::MAX {
                break;
            }
        }

        if best_distance_sq == f32::MAX {
            return (1.0, 0.0);
        }

        let heading = Vec2::from_angle(heading_angle);
        (
            best_distance_sq.sqrt() / WORLD_DIAGONAL,
            signed_angle(heading, best_delta) / std::f32::consts::PI,
        )
    }

    fn hits_near(&self, origin: Vec2, items: &[Vec2], radius: f32) -> Vec<usize> {
        if items.is_empty() {
            return Vec::new();
        }

        let radius_sq = radius * radius;
        let base_x = ((origin.x / self.cell_size).floor() as isize).rem_euclid(self.cols as isize);
        let base_y = ((origin.y / self.cell_size).floor() as isize).rem_euclid(self.rows as isize);
        let mut hits = Vec::new();

        for dx in -1..=1 {
            for dy in -1..=1 {
                let x = (base_x + dx).rem_euclid(self.cols as isize) as usize;
                let y = (base_y + dy).rem_euclid(self.rows as isize) as usize;
                for &item_index in &self.buckets[y * self.cols + x] {
                    let delta = toroidal_delta(origin, items[item_index]);
                    let distance_sq = delta.x * delta.x + delta.y * delta.y;
                    if distance_sq <= radius_sq {
                        hits.push(item_index);
                    }
                }
            }
        }

        hits
    }
}

#[derive(Clone)]
struct Environment {
    food: Vec<Vec2>,
    poison: Vec<Vec2>,
    food_hash: SpatialHash,
    poison_hash: SpatialHash,
}

impl Environment {
    fn new(rng: &mut SmallRng, population_size: usize) -> Self {
        let mut env = Self {
            food: Vec::new(),
            poison: Vec::new(),
            food_hash: SpatialHash::new(HASH_CELL_SIZE),
            poison_hash: SpatialHash::new(HASH_CELL_SIZE),
        };
        env.reset(rng, population_size);
        env
    }

    fn reset(&mut self, rng: &mut SmallRng, population_size: usize) {
        self.food.clear();
        self.poison.clear();
        let food_target = Self::food_target(population_size);
        let poison_target = Self::poison_target(population_size);
        self.food.reserve(food_target);
        self.poison.reserve(poison_target);
        for _ in 0..food_target {
            self.food.push(random_point(rng));
        }
        for _ in 0..poison_target {
            self.poison.push(random_point(rng));
        }
        self.rebuild();
    }

    fn replenish(&mut self, rng: &mut SmallRng, population_size: usize, food_spawn_rate: u32) {
        let food_target = Self::food_target(population_size);
        let poison_target = Self::poison_target(population_size);
        let food_to_add =
            (food_target.saturating_sub(self.food.len())).min(food_spawn_rate as usize);
        let poison_to_add = (poison_target.saturating_sub(self.poison.len()))
            .min((food_spawn_rate / 2 + 1) as usize);

        for _ in 0..food_to_add {
            self.food.push(random_point(rng));
        }
        for _ in 0..poison_to_add {
            self.poison.push(random_point(rng));
        }

        if food_to_add > 0 || poison_to_add > 0 {
            self.rebuild();
        }
    }

    fn remove_hits(&mut self, food_hits: &HashSet<usize>, poison_hits: &HashSet<usize>) {
        if !food_hits.is_empty() {
            remove_indices_descending(&mut self.food, food_hits);
        }
        if !poison_hits.is_empty() {
            remove_indices_descending(&mut self.poison, poison_hits);
        }
        if !food_hits.is_empty() || !poison_hits.is_empty() {
            self.rebuild();
        }
    }

    fn rebuild(&mut self) {
        self.food_hash.rebuild(&self.food);
        self.poison_hash.rebuild(&self.poison);
    }

    fn food_target(population_size: usize) -> usize {
        (population_size / 12).clamp(300, 4_000)
    }

    fn poison_target(population_size: usize) -> usize {
        (population_size / 18).clamp(180, 2_600)
    }
}

fn remove_indices_descending(items: &mut Vec<Vec2>, hits: &HashSet<usize>) {
    let mut indices: Vec<_> = hits.iter().copied().collect();
    indices.sort_unstable_by(|a, b| b.cmp(a));
    for index in indices {
        if index < items.len() {
            items.swap_remove(index);
        }
    }
}

#[derive(Clone)]
struct AgentStorage {
    positions: Vec<Vec2>,
    velocities: Vec<Vec2>,
    angles: Vec<f32>,
    energies: Vec<f32>,
    ages: Vec<u32>,
    fitness: Vec<f32>,
    food_eaten: Vec<u32>,
    poison_hits: Vec<u32>,
    alive: Vec<bool>,
    brains: Vec<Genome>,
    cluster_ids: Vec<u8>, // 0 for default, 1+ for specific clusters
}

impl AgentStorage {
    fn new(
        rng: &mut SmallRng,
        tracker: &mut InnovationTracker,
        config: &ControlConfig,
    ) -> Self {
        let population_size = config.population_size;
        let mut positions = Vec::with_capacity(population_size);
        let mut velocities = Vec::with_capacity(population_size);
        let mut angles = Vec::with_capacity(population_size);
        let mut energies = Vec::with_capacity(population_size);
        let mut ages = Vec::with_capacity(population_size);
        let mut fitness = Vec::with_capacity(population_size);
        let mut food_eaten = Vec::with_capacity(population_size);
        let mut poison_hits = Vec::with_capacity(population_size);
        let mut alive = Vec::with_capacity(population_size);
        let mut brains = Vec::with_capacity(population_size);
        let mut cluster_ids = Vec::with_capacity(population_size);

        if config.clusters.is_empty() {
            for _ in 0..population_size {
                positions.push(random_point(rng));
                velocities.push(Vec2::default());
                angles.push(rng.random_range(-std::f32::consts::PI..std::f32::consts::PI));
                energies.push(BASE_ENERGY);
                ages.push(0);
                fitness.push(0.0);
                food_eaten.push(0);
                poison_hits.push(0);
                alive.push(true);
                brains.push(Genome::minimal(tracker, rng));
                cluster_ids.push(0);
            }
        } else {
            let mut remaining = population_size;
            for (c_idx, cluster) in config.clusters.iter().enumerate() {
                let count = if c_idx == config.clusters.len() - 1 {
                    remaining
                } else {
                    ((population_size as f32) * cluster.size_ratio).floor() as usize
                };
                remaining = remaining.saturating_sub(count);

                for _ in 0..count {
                    positions.push(random_point(rng));
                    velocities.push(Vec2::default());
                    angles.push(rng.random_range(-std::f32::consts::PI..std::f32::consts::PI));
                    energies.push(BASE_ENERGY);
                    ages.push(0);
                    fitness.push(0.0);
                    food_eaten.push(0);
                    poison_hits.push(0);
                    alive.push(true);

                    // Proxy mapping: high opscore -> more initial random connections
                    let mut genome = Genome::minimal(tracker, rng);
                    let mutation_attempts = (cluster.mean_opscore * 5.0) as usize;
                    for _ in 0..mutation_attempts {
                        genome.add_node_mutation(tracker, rng);
                        genome.add_connection_mutation(tracker, rng);
                    }
                    genome.rebuild_compiled();
                    
                    brains.push(genome);
                    cluster_ids.push((c_idx + 1) as u8);
                }
            }
        }

        Self {
            positions,
            velocities,
            angles,
            energies,
            ages,
            fitness,
            food_eaten,
            poison_hits,
            alive,
            brains,
            cluster_ids,
        }
    }

    fn len(&self) -> usize {
        self.positions.len()
    }

    fn rebuild_all_compiled(&mut self) {
        for brain in &mut self.brains {
            brain.rebuild_compiled();
        }
    }

    fn replace_population(
        &mut self,
        rng: &mut SmallRng,
        offspring_data: Vec<(Genome, u8)>,
        population_size: usize,
    ) {
        self.positions.clear();
        self.velocities.clear();
        self.angles.clear();
        self.energies.clear();
        self.ages.clear();
        self.fitness.clear();
        self.food_eaten.clear();
        self.poison_hits.clear();
        self.alive.clear();
        
        let (brains, cluster_ids): (Vec<Genome>, Vec<u8>) = offspring_data.into_iter().unzip();
        self.brains = brains;
        self.cluster_ids = cluster_ids;

        self.positions.reserve(population_size);
        self.velocities.reserve(population_size);
        self.angles.reserve(population_size);
        self.energies.reserve(population_size);
        self.ages.reserve(population_size);
        self.fitness.reserve(population_size);
        self.food_eaten.reserve(population_size);
        self.poison_hits.reserve(population_size);
        self.alive.reserve(population_size);

        for _ in 0..population_size {
            self.positions.push(random_point(rng));
            self.velocities.push(Vec2::default());
            self.angles
                .push(rng.random_range(-std::f32::consts::PI..std::f32::consts::PI));
            self.energies.push(BASE_ENERGY);
            self.ages.push(0);
            self.fitness.push(0.0);
            self.food_eaten.push(0);
            self.poison_hits.push(0);
            self.alive.push(true);
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum NodeKind {
    Input,
    Bias,
    Hidden,
    Output,
}

#[derive(Clone)]
struct NodeGene {
    id: u32,
    kind: NodeKind,
    order: f32,
    slot: Option<usize>,
}

#[derive(Clone)]
struct ConnectionGene {
    innovation: u64,
    from: u32,
    to: u32,
    weight: f32,
    enabled: bool,
}

#[derive(Clone)]
struct CompiledEdge {
    from_idx: usize,
    weight: f32,
}

#[derive(Clone, Default)]
struct CompiledGenome {
    ordered_indices: Vec<usize>,
    incoming: Vec<Vec<CompiledEdge>>,
    output_indices: Vec<usize>,
    complexity: usize,
}

#[derive(Clone)]
struct Genome {
    nodes: Vec<NodeGene>,
    connections: Vec<ConnectionGene>,
    compiled: CompiledGenome,
}

impl Genome {
    fn minimal(tracker: &mut InnovationTracker, rng: &mut SmallRng) -> Self {
        let mut nodes = Vec::with_capacity(INPUT_COUNT + OUTPUT_COUNT + 1);
        for input in 0..INPUT_COUNT {
            nodes.push(NodeGene {
                id: input as u32,
                kind: NodeKind::Input,
                order: 0.0,
                slot: Some(input),
            });
        }
        nodes.push(NodeGene {
            id: INPUT_COUNT as u32,
            kind: NodeKind::Bias,
            order: 0.0,
            slot: None,
        });
        for output in 0..OUTPUT_COUNT {
            nodes.push(NodeGene {
                id: tracker.base_output_id(output),
                kind: NodeKind::Output,
                order: 1.0,
                slot: Some(output),
            });
        }

        let mut connections = Vec::new();
        for input in 0..=INPUT_COUNT {
            for output in 0..OUTPUT_COUNT {
                let from = input as u32;
                let to = tracker.base_output_id(output);
                connections.push(ConnectionGene {
                    innovation: tracker.connection_innovation(from, to),
                    from,
                    to,
                    weight: rng.random_range(-1.0..1.0),
                    enabled: true,
                });
            }
        }

        let mut genome = Self {
            nodes,
            connections,
            compiled: CompiledGenome::default(),
        };
        genome.rebuild_compiled();
        genome
    }

    fn evaluate(&self, inputs: &[f32; INPUT_COUNT]) -> [f32; OUTPUT_COUNT] {
        let mut activations = vec![0.0; self.nodes.len()];

        for (index, node) in self.nodes.iter().enumerate() {
            match node.kind {
                NodeKind::Input => {
                    activations[index] = inputs[node.slot.expect("input nodes have a slot")];
                }
                NodeKind::Bias => activations[index] = 1.0,
                NodeKind::Hidden | NodeKind::Output => {}
            }
        }

        for &node_index in &self.compiled.ordered_indices {
            match self.nodes[node_index].kind {
                NodeKind::Input | NodeKind::Bias => continue,
                NodeKind::Hidden | NodeKind::Output => {
                    let sum = self.compiled.incoming[node_index]
                        .iter()
                        .fold(0.0, |acc, edge| {
                            acc + activations[edge.from_idx] * edge.weight
                        });
                    activations[node_index] = fast_tanh(sum);
                }
            }
        }

        let mut output = [0.0; OUTPUT_COUNT];
        for (slot, &node_index) in self.compiled.output_indices.iter().enumerate() {
            output[slot] = activations[node_index];
        }
        output
    }

    fn complexity(&self) -> usize {
        self.compiled.complexity
    }

    fn crossover(
        left: &Genome,
        left_fitness: f32,
        right: &Genome,
        right_fitness: f32,
        rng: &mut SmallRng,
    ) -> Self {
        let (primary, secondary) = match left_fitness
            .partial_cmp(&right_fitness)
            .unwrap_or(Ordering::Equal)
        {
            Ordering::Greater => (left, right),
            Ordering::Less => (right, left),
            Ordering::Equal => {
                if rng.random_bool(0.5) {
                    (left, right)
                } else {
                    (right, left)
                }
            }
        };

        let secondary_lookup: HashMap<u64, &ConnectionGene> = secondary
            .connections
            .iter()
            .map(|gene| (gene.innovation, gene))
            .collect();

        let mut nodes: HashMap<u32, NodeGene> = primary
            .nodes
            .iter()
            .cloned()
            .map(|node| (node.id, node))
            .collect();
        for node in &secondary.nodes {
            nodes.entry(node.id).or_insert_with(|| node.clone());
        }

        let mut connections = Vec::new();
        for primary_gene in &primary.connections {
            let chosen =
                if let Some(secondary_gene) = secondary_lookup.get(&primary_gene.innovation) {
                    let mut gene = if rng.random_bool(0.5) {
                        primary_gene.clone()
                    } else {
                        (*secondary_gene).clone()
                    };
                    if (!primary_gene.enabled || !secondary_gene.enabled) && rng.random_bool(0.75) {
                        gene.enabled = false;
                    }
                    gene
                } else {
                    primary_gene.clone()
                };
            connections.push(chosen);
        }

        let referenced: HashSet<u32> = connections
            .iter()
            .flat_map(|gene| [gene.from, gene.to])
            .collect();
        let mut node_list: Vec<_> = nodes
            .into_values()
            .filter(|node| node.kind != NodeKind::Hidden || referenced.contains(&node.id))
            .collect();
        node_list.sort_by(|a, b| a.order.partial_cmp(&b.order).unwrap_or(Ordering::Equal));

        let mut genome = Self {
            nodes: node_list,
            connections,
            compiled: CompiledGenome::default(),
        };
        genome.rebuild_compiled();
        genome
    }

    fn mutate(&mut self, tracker: &mut InnovationTracker, rng: &mut SmallRng, mutation_rate: f32) {
        let severity = mutation_rate.clamp(0.0, 1.0);
        self.mutate_weights(rng, severity);

        if rng.random_bool((severity * 0.38).clamp(0.02, 0.85) as f64) {
            self.add_connection_mutation(tracker, rng);
        }
        if rng.random_bool((severity * 0.18).clamp(0.01, 0.55) as f64) {
            self.add_node_mutation(tracker, rng);
        }
        if rng.random_bool((severity * 0.08).clamp(0.005, 0.25) as f64) {
            self.toggle_connection(rng);
        }

        self.rebuild_compiled();
    }

    fn mutate_weights(&mut self, rng: &mut SmallRng, severity: f32) {
        for gene in &mut self.connections {
            if rng.random_bool((0.18 + severity * 0.5).min(0.95) as f64) {
                gene.weight += rng.random_range(-1.0..1.0) * (0.12 + severity * 0.35);
            }
            if rng.random_bool((0.04 + severity * 0.12).min(0.35) as f64) {
                gene.weight = rng.random_range(-1.5..1.5);
            }
            gene.weight = gene.weight.clamp(-3.5, 3.5);
        }
    }

    fn add_connection_mutation(&mut self, tracker: &mut InnovationTracker, rng: &mut SmallRng) {
        let mut candidates = Vec::new();
        for from in &self.nodes {
            if from.kind == NodeKind::Output {
                continue;
            }
            for to in &self.nodes {
                if matches!(to.kind, NodeKind::Input | NodeKind::Bias) {
                    continue;
                }
                if from.order >= to.order {
                    continue;
                }
                if self
                    .connections
                    .iter()
                    .any(|gene| gene.from == from.id && gene.to == to.id)
                {
                    continue;
                }
                candidates.push((from.id, to.id));
            }
        }

        if let Some(&(from, to)) = candidates.choose(rng) {
            self.connections.push(ConnectionGene {
                innovation: tracker.connection_innovation(from, to),
                from,
                to,
                weight: rng.random_range(-1.2..1.2),
                enabled: true,
            });
        }
    }

    fn add_node_mutation(&mut self, tracker: &mut InnovationTracker, rng: &mut SmallRng) {
        let enabled_indices: Vec<usize> = self
            .connections
            .iter()
            .enumerate()
            .filter_map(|(index, gene)| gene.enabled.then_some(index))
            .collect();
        let Some(&connection_index) = enabled_indices.choose(rng) else {
            return;
        };

        let original = self.connections[connection_index].clone();
        self.connections[connection_index].enabled = false;

        let Some(from_node) = self
            .nodes
            .iter()
            .find(|node| node.id == original.from)
            .cloned()
        else {
            return;
        };
        let Some(to_node) = self
            .nodes
            .iter()
            .find(|node| node.id == original.to)
            .cloned()
        else {
            return;
        };

        let (node_id, first_innovation, second_innovation) =
            tracker.split_connection(original.innovation);
        if !self.nodes.iter().any(|node| node.id == node_id) {
            let mut order = (from_node.order + to_node.order) * 0.5;
            if (to_node.order - from_node.order).abs() < 1e-4 {
                order += 0.001;
            }
            self.nodes.push(NodeGene {
                id: node_id,
                kind: NodeKind::Hidden,
                order,
                slot: None,
            });
        }

        self.connections.push(ConnectionGene {
            innovation: first_innovation,
            from: original.from,
            to: node_id,
            weight: 1.0,
            enabled: true,
        });
        self.connections.push(ConnectionGene {
            innovation: second_innovation,
            from: node_id,
            to: original.to,
            weight: original.weight,
            enabled: true,
        });
    }

    fn toggle_connection(&mut self, rng: &mut SmallRng) {
        if !self.connections.is_empty() {
            let index = rng.random_range(0..self.connections.len());
            self.connections[index].enabled = !self.connections[index].enabled;
        }
    }

    fn rebuild_compiled(&mut self) {
        self.nodes.sort_by(|a, b| {
            a.order
                .partial_cmp(&b.order)
                .unwrap_or(Ordering::Equal)
                .then_with(|| a.id.cmp(&b.id))
        });

        let node_index: HashMap<u32, usize> = self
            .nodes
            .iter()
            .enumerate()
            .map(|(index, node)| (node.id, index))
            .collect();

        let mut incoming = vec![Vec::new(); self.nodes.len()];
        let mut complexity = 0;
        for gene in self.connections.iter().filter(|gene| gene.enabled) {
            let Some(&from_idx) = node_index.get(&gene.from) else {
                continue;
            };
            let Some(&to_idx) = node_index.get(&gene.to) else {
                continue;
            };
            incoming[to_idx].push(CompiledEdge {
                from_idx,
                weight: gene.weight,
            });
            complexity += 1;
        }

        let ordered_indices: Vec<usize> = (0..self.nodes.len()).collect();
        let output_indices = self
            .nodes
            .iter()
            .enumerate()
            .filter_map(|(index, node)| (node.kind == NodeKind::Output).then_some(index))
            .collect();

        self.compiled = CompiledGenome {
            ordered_indices,
            incoming,
            output_indices,
            complexity,
        };
    }
}

struct InnovationTracker {
    next_node_id: u32,
    next_innovation: u64,
    connection_map: HashMap<(u32, u32), u64>,
    split_map: HashMap<u64, (u32, u64, u64)>,
}

impl InnovationTracker {
    fn new() -> Self {
        Self {
            next_node_id: (INPUT_COUNT + 1 + OUTPUT_COUNT) as u32,
            next_innovation: 0,
            connection_map: HashMap::new(),
            split_map: HashMap::new(),
        }
    }

    fn base_output_id(&self, output_slot: usize) -> u32 {
        (INPUT_COUNT + 1 + output_slot) as u32
    }

    fn connection_innovation(&mut self, from: u32, to: u32) -> u64 {
        if let Some(existing) = self.connection_map.get(&(from, to)) {
            *existing
        } else {
            let innovation = self.next_innovation;
            self.next_innovation += 1;
            self.connection_map.insert((from, to), innovation);
            innovation
        }
    }

    fn split_connection(&mut self, original_innovation: u64) -> (u32, u64, u64) {
        if let Some(existing) = self.split_map.get(&original_innovation) {
            *existing
        } else {
            let new_node_id = self.next_node_id;
            self.next_node_id += 1;
            let first_innovation = self.next_innovation;
            self.next_innovation += 1;
            let second_innovation = self.next_innovation;
            self.next_innovation += 1;
            let value = (new_node_id, first_innovation, second_innovation);
            self.split_map.insert(original_innovation, value);
            value
        }
    }
}

struct StepOutcome {
    index: usize,
    position: Vec2,
    velocity: Vec2,
    angle: f32,
    energy: f32,
    age: u32,
    provisional_fitness: f32,
    alive: bool,
    food_hits: Vec<usize>,
    poison_hits: Vec<usize>,
}

pub struct Simulation {
    rng: SmallRng,
    session_seed: u64,
    initial_config: ControlConfig,
    config: ControlConfig,
    innovation: InnovationTracker,
    world: Environment,
    agents: AgentStorage,
    generation: u32,
    tick: u64,
    halted: bool,
    history: Vec<HistoryPoint>,
    last_average_lifespan: f32,
    top_fitness_ever: f32,
    latest_average_complexity: f32,
    latest_packet: Vec<u8>,
    session_events: Vec<RecordedEvent>,
    session_dirty: bool,
    replay: Option<ReplayState>,
}

impl Simulation {
    pub fn shared(config: ControlConfig) -> SharedSimulation {
        Arc::new(RwLock::new(Self::new(config)))
    }

    pub fn new(config: ControlConfig) -> Self {
        Self::with_seed(config, 7)
    }

    fn with_seed(config: ControlConfig, seed: u64) -> Self {
        let mut rng = SmallRng::seed_from_u64(seed);
        let mut innovation = InnovationTracker::new();
        let agents = AgentStorage::new(&mut rng, &mut innovation, &config);
        let world = Environment::new(&mut rng, config.population_size);

        let mut simulation = Self {
            rng,
            session_seed: seed,
            initial_config: config.clone(),
            config,
            innovation,
            world,
            agents,
            generation: 1,
            tick: 0,
            halted: false,
            history: Vec::new(),
            last_average_lifespan: 0.0,
            top_fitness_ever: 0.0,
            latest_average_complexity: 0.0,
            latest_packet: Vec::new(),
            session_events: Vec::new(),
            session_dirty: true,
            replay: None,
        };
        simulation.latest_average_complexity = simulation.average_brain_complexity();
        simulation.latest_packet = simulation.pack_current_frame();
        simulation
    }

    pub fn step(&mut self) -> Vec<u8> {
        self.apply_replay_events();

        if self.halted {
            return self.pack_current_frame();
        }

        let positions = &self.agents.positions;
        let velocities = &self.agents.velocities;
        let angles = &self.agents.angles;
        let energies = &self.agents.energies;
        let ages = &self.agents.ages;
        let fitness = &self.agents.fitness;
        let food_eaten = &self.agents.food_eaten;
        let poison_hits = &self.agents.poison_hits;
        let alive = &self.agents.alive;
        let brains = &self.agents.brains;
        let food = &self.world.food;
        let poison = &self.world.poison;
        let food_hash = &self.world.food_hash;
        let poison_hash = &self.world.poison_hash;
        let energy_decay = self.config.energy_decay;

        let outcomes: Vec<StepOutcome> = (0..self.agents.len())
            .into_par_iter()
            .map(|index| {
                if !alive[index] {
                    return StepOutcome {
                        index,
                        position: positions[index],
                        velocity: velocities[index],
                        angle: angles[index],
                        energy: 0.0,
                        age: ages[index],
                        provisional_fitness: fitness[index],
                        alive: false,
                        food_hits: Vec::new(),
                        poison_hits: Vec::new(),
                    };
                }

                let (food_distance, food_bearing) =
                    food_hash.nearest_sensor(positions[index], angles[index], food);
                let (poison_distance, poison_bearing) =
                    poison_hash.nearest_sensor(positions[index], angles[index], poison);

                let inputs = [
                    food_distance,
                    food_bearing,
                    poison_distance,
                    poison_bearing,
                    energies[index] / MAX_ENERGY,
                ];

                let [turn_signal, thrust_signal] = brains[index].evaluate(&inputs);
                let angle = angles[index] + turn_signal * TURN_RATE;
                let thrust = ((thrust_signal + 1.0) * 0.5).clamp(0.0, 1.0) * THRUST;
                let direction = Vec2::from_angle(angle);
                let mut velocity = velocities[index] * DRAG + direction * thrust;
                let speed = velocity.length();
                if speed > MAX_SPEED {
                    velocity = velocity * (MAX_SPEED / speed);
                }
                let position = (positions[index] + velocity).wrapped();
                let motion_cost = 0.12 * velocity.length();
                let energy = (energies[index] - energy_decay - motion_cost).max(0.0);
                let age = ages[index] + 1;
                let provisional_fitness = age as f32 + food_eaten[index] as f32 * 18.0
                    - poison_hits[index] as f32 * 14.0
                    + energy * 0.2;

                StepOutcome {
                    index,
                    position,
                    velocity,
                    angle,
                    energy,
                    age,
                    provisional_fitness,
                    alive: energy > 0.0,
                    food_hits: food_hash.hits_near(position, food, COLLISION_RADIUS),
                    poison_hits: poison_hash.hits_near(position, poison, COLLISION_RADIUS),
                }
            })
            .collect();

        self.tick += 1;

        let mut eaten_food = HashSet::new();
        let mut touched_poison = HashSet::new();
        let mut alive_count = 0usize;
        let mut best_fitness = 0.0_f32;

        for outcome in outcomes {
            let index = outcome.index;
            self.agents.positions[index] = outcome.position;
            self.agents.velocities[index] = outcome.velocity;
            self.agents.angles[index] = outcome.angle;
            self.agents.energies[index] = outcome.energy;
            self.agents.ages[index] = outcome.age;
            self.agents.fitness[index] = outcome.provisional_fitness;
            self.agents.alive[index] = outcome.alive;

            if outcome.alive {
                for food_index in outcome.food_hits {
                    if eaten_food.insert(food_index) {
                        self.agents.energies[index] =
                            (self.agents.energies[index] + FOOD_ENERGY).min(MAX_ENERGY);
                        self.agents.food_eaten[index] += 1;
                    }
                }
                for poison_index in outcome.poison_hits {
                    if touched_poison.insert(poison_index) {
                        self.agents.energies[index] =
                            (self.agents.energies[index] - POISON_DAMAGE).max(0.0);
                        self.agents.poison_hits[index] += 1;
                    }
                }
            }

            self.agents.alive[index] = self.agents.energies[index] > 0.0;
            self.agents.fitness[index] = self.agents.ages[index] as f32
                + self.agents.food_eaten[index] as f32 * 18.0
                - self.agents.poison_hits[index] as f32 * 14.0
                + self.agents.energies[index] * 0.2;

            best_fitness = best_fitness.max(self.agents.fitness[index]);
            if self.agents.alive[index] {
                alive_count += 1;
            }
        }

        self.world.remove_hits(&eaten_food, &touched_poison);
        self.world.replenish(
            &mut self.rng,
            self.config.population_size,
            self.config.food_spawn_rate,
        );

        self.top_fitness_ever = self.top_fitness_ever.max(best_fitness);
        self.latest_average_complexity = self.average_brain_complexity();
        if self.replay.is_none() {
            self.session_dirty = true;
        }

        if alive_count == 0 {
            self.advance_generation();
        }

        if let Some(replay) = &self.replay {
            if self.tick >= replay.final_tick {
                self.halted = true;
            }
        }

        self.pack_current_frame()
    }

    fn advance_generation(&mut self) {
        let mut ranked: Vec<usize> = (0..self.agents.len()).collect();
        ranked.sort_unstable_by(|&left, &right| {
            self.agents.fitness[right]
                .partial_cmp(&self.agents.fitness[left])
                .unwrap_or(Ordering::Equal)
                .then_with(|| self.agents.ages[right].cmp(&self.agents.ages[left]))
        });

        let average_lifespan =
            self.agents.ages.iter().sum::<u32>() as f32 / self.agents.len() as f32;
        let max_fitness = self.agents.fitness.iter().copied().fold(0.0_f32, f32::max);
        let average_complexity = self.average_brain_complexity();

        self.last_average_lifespan = average_lifespan;
        self.history.push(HistoryPoint {
            generation: self.generation,
            average_lifespan: round2(average_lifespan),
            max_fitness: round2(max_fitness),
            average_brain_complexity: round2(average_complexity),
        });
        if self.history.len() > HISTORY_LIMIT {
            let overflow = self.history.len() - HISTORY_LIMIT;
            self.history.drain(0..overflow);
        }

        if self.generation >= self.config.max_generations {
            self.halted = true;
            self.latest_average_complexity = average_complexity;
            return;
        }

        let elite_count = ((self.agents.len() as f32) * 0.1).ceil() as usize;
        let elite_count = elite_count.max(2).min(ranked.len());
        let elites = &ranked[..elite_count];

        let mut offspring = Vec::with_capacity(self.config.population_size);
        for _ in 0..self.config.population_size {
            let parent_a = *elites
                .choose(&mut self.rng)
                .expect("elite pool must be non-empty");
            let parent_b = *elites
                .choose(&mut self.rng)
                .expect("elite pool must be non-empty");

            let cluster_id = self.agents.cluster_ids[parent_a]; // Child inherits cluster from parent A

            let mut child = Genome::crossover(
                &self.agents.brains[parent_a],
                self.agents.fitness[parent_a],
                &self.agents.brains[parent_b],
                self.agents.fitness[parent_b],
                &mut self.rng,
            );
            child.mutate(
                &mut self.innovation,
                &mut self.rng,
                self.config.mutation_rate,
            );
            offspring.push((child, cluster_id));
        }

        self.generation += 1;
        self.halted = false;
        self.world.reset(&mut self.rng, self.config.population_size);
        self.agents
            .replace_population(&mut self.rng, offspring, self.config.population_size);
        self.latest_average_complexity = self.average_brain_complexity();
    }

    fn average_brain_complexity(&self) -> f32 {
        if self.agents.brains.is_empty() {
            return 0.0;
        }
        self.agents
            .brains
            .iter()
            .map(|brain| brain.complexity() as f32)
            .sum::<f32>()
            / self.agents.brains.len() as f32
    }

    pub fn apply_config_patch(&mut self, patch: ConfigPatch) {
        self.apply_config_patch_internal(patch, true);
    }

    fn apply_config_patch_internal(&mut self, patch: ConfigPatch, record_event: bool) {
        if record_event {
            self.session_events.push(RecordedEvent {
                tick: self.tick,
                action: RecordedAction::ConfigPatch {
                    patch: patch.clone(),
                },
            });
            self.session_dirty = true;
        }

        let original_population = self.config.population_size;

        if let Some(mutation_rate) = patch.mutation_rate {
            self.config.mutation_rate = mutation_rate.clamp(0.0, 1.0);
        }
        if let Some(population_size) = patch.population_size {
            self.config.population_size = population_size.clamp(128, 50_000);
        }
        if let Some(max_generations) = patch.max_generations {
            self.config.max_generations = max_generations.max(1);
        }
        if let Some(food_spawn_rate) = patch.food_spawn_rate {
            self.config.food_spawn_rate = food_spawn_rate.clamp(1, 512);
        }
        if let Some(energy_decay) = patch.energy_decay {
            self.config.energy_decay = energy_decay.clamp(0.05, 4.0);
        }
        if let Some(tick_rate) = patch.tick_rate {
            self.config.tick_rate = tick_rate.clamp(1, 240);
        }

        if self.config.population_size != original_population {
            let mut fresh_offspring = Vec::with_capacity(self.config.population_size);
            if self.agents.brains.is_empty() {
                for _ in 0..self.config.population_size {
                    fresh_offspring.push((Genome::minimal(&mut self.innovation, &mut self.rng), 0));
                }
            } else {
                for _ in 0..self.config.population_size {
                    let source_idx = self.rng.random_range(0..self.agents.brains.len());
                    fresh_offspring.push((
                        self.agents.brains[source_idx].clone(),
                        self.agents.cluster_ids[source_idx],
                    ));
                }
            }
            self.world.reset(&mut self.rng, self.config.population_size);
            self.agents.replace_population(
                &mut self.rng,
                fresh_offspring,
                self.config.population_size,
            );
        }

        self.halted = self.generation >= self.config.max_generations && !self.history.is_empty();
        self.latest_average_complexity = self.average_brain_complexity();
        self.pack_current_frame();
    }

    pub fn kill_half_population(&mut self) -> GodModeResponse {
        self.kill_half_population_internal(true)
    }

    fn kill_half_population_internal(&mut self, record_event: bool) -> GodModeResponse {
        if record_event {
            self.session_events.push(RecordedEvent {
                tick: self.tick,
                action: RecordedAction::GodMode,
            });
            self.session_dirty = true;
        }

        let mut live_indices: Vec<usize> = self
            .agents
            .alive
            .iter()
            .enumerate()
            .filter_map(|(index, alive)| alive.then_some(index))
            .collect();
        live_indices.shuffle(&mut self.rng);
        let remove_count = live_indices.len() / 2;

        for &index in live_indices.iter().take(remove_count) {
            self.agents.alive[index] = false;
            self.agents.energies[index] = 0.0;
        }

        let alive_after = self.agents.alive.iter().filter(|alive| **alive).count();
        self.pack_current_frame();

        GodModeResponse {
            removed_agents: remove_count,
            alive_after,
        }
    }

    pub fn save_recording(&mut self, name: Option<String>) -> Result<RecordingSummary, String> {
        let saved_at_ms = now_unix_ms();
        let id = format!("session-{saved_at_ms}");
        let summary = RecordingSummary {
            id: id.clone(),
            name: name.unwrap_or_else(|| format!("Session {}", self.generation)),
            saved_at_ms,
            seed: self.session_seed,
            final_generation: self.generation,
            final_tick: self.tick,
            population_size: self.config.population_size,
            max_generations: self.config.max_generations,
        };

        let file = RecordingFile {
            summary: summary.clone(),
            initial_config: self.initial_config.clone(),
            final_config: self.config.clone(),
            history: self.history.clone(),
            events: self.session_events.clone(),
        };

        let directory = recordings_dir();
        fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        let path = directory.join(format!("{id}.json"));
        let payload = serde_json::to_vec_pretty(&file).map_err(|error| error.to_string())?;
        fs::write(path, payload).map_err(|error| error.to_string())?;
        self.session_dirty = false;
        self.replay = None;
        Ok(summary)
    }

    pub fn list_recordings(&self) -> Result<Vec<RecordingSummary>, String> {
        let directory = recordings_dir();
        if !directory.exists() {
            return Ok(Vec::new());
        }

        let mut summaries = Vec::new();
        for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            let payload = fs::read_to_string(path).map_err(|error| error.to_string())?;
            let file: RecordingFile =
                serde_json::from_str(&payload).map_err(|error| error.to_string())?;
            summaries.push(file.summary);
        }

        summaries.sort_by(|left, right| right.saved_at_ms.cmp(&left.saved_at_ms));
        Ok(summaries)
    }

    pub fn replay_recording(&mut self, recording_id: &str) -> Result<RecordingSummary, String> {
        let file = load_recording(recording_id)?;
        *self = Self::with_seed(file.initial_config.clone(), file.summary.seed);
        self.initial_config = file.initial_config.clone();
        self.session_seed = file.summary.seed;
        self.session_events = file.events.clone();
        self.session_dirty = false;
        self.replay = Some(ReplayState {
            recording_id: file.summary.id.clone(),
            events: file.events,
            next_event_index: 0,
            final_tick: file.summary.final_tick,
        });
        self.config.max_generations = file.final_config.max_generations;
        self.pack_current_frame();
        Ok(file.summary)
    }

    fn apply_replay_events(&mut self) {
        loop {
            let next_event = self
                .replay
                .as_ref()
                .and_then(|replay| replay.events.get(replay.next_event_index).cloned());

            let Some(event) = next_event else {
                break;
            };
            if event.tick > self.tick {
                break;
            }

            match event.action {
                RecordedAction::ConfigPatch { patch } => {
                    self.apply_config_patch_internal(patch, false);
                }
                RecordedAction::GodMode => {
                    let _ = self.kill_half_population_internal(false);
                }
            }

            if let Some(replay) = &mut self.replay {
                replay.next_event_index += 1;
            }
        }
    }

    pub fn status(&self) -> StatusResponse {
        let alive = self.agents.alive.iter().filter(|alive| **alive).count();
        let average_energy = if alive == 0 {
            0.0
        } else {
            self.agents
                .energies
                .iter()
                .zip(&self.agents.alive)
                .filter_map(|(energy, alive)| alive.then_some(*energy))
                .sum::<f32>()
                / alive as f32
        };
        let current_max_fitness = self.agents.fitness.iter().copied().fold(0.0_f32, f32::max);

        StatusResponse {
            generation: self.generation,
            tick: self.tick,
            halted: self.halted,
            config: self.config.clone(),
            metrics: StatusMetrics {
                alive,
                population: self.config.population_size,
                average_energy: round2(average_energy),
                average_lifespan: round2(self.last_average_lifespan),
                max_fitness: round2(current_max_fitness.max(self.top_fitness_ever)),
                top_fitness_ever: round2(self.top_fitness_ever),
                average_brain_complexity: round2(self.latest_average_complexity),
            },
            history: self.history.clone(),
            session: SessionState {
                seed: self.session_seed,
                replaying: self.replay.is_some(),
                recording_dirty: self.session_dirty,
                active_recording: self
                    .replay
                    .as_ref()
                    .map(|replay| replay.recording_id.clone()),
            },
        }
    }

    pub fn pack_current_frame(&mut self) -> Vec<u8> {
        let packet = self.pack_frame();
        self.latest_packet = packet.clone();
        packet
    }

    pub fn current_packet(&self) -> Vec<u8> {
        self.latest_packet.clone()
    }

    pub fn is_halted(&self) -> bool {
        self.halted
    }

    pub fn config(&self) -> &ControlConfig {
        &self.config
    }

    fn pack_frame(&self) -> Vec<u8> {
        let alive_indices: Vec<usize> = self
            .agents
            .alive
            .iter()
            .enumerate()
            .filter_map(|(index, alive)| alive.then_some(index))
            .collect();

        let header_bytes = 9 * std::mem::size_of::<u32>();
        let payload_floats =
            alive_indices.len() * 4 + self.world.food.len() * 2 + self.world.poison.len() * 2;
        let mut buffer =
            Vec::with_capacity(header_bytes + payload_floats * std::mem::size_of::<f32>());

        // Header layout, all little-endian:
        // [u32 generation, u32 tick, u32 alive_agents, u32 food_count, u32 poison_count,
        //  u32 halted_flag, f32 top_fitness, f32 average_lifespan, f32 average_complexity]
        //
        // After the 36-byte header:
        // agents: [x, y, energy, angle, cluster_id] * alive_agents
        // food:   [x, y] * food_count
        // poison: [x, y] * poison_count
        //
        // The frontend can jump through the frame with simple index math because every record
        // is packed as a fixed-width float tuple with no JSON parsing or string decoding.
        push_u32(&mut buffer, self.generation);
        push_u32(&mut buffer, self.tick.min(u32::MAX as u64) as u32);
        push_u32(&mut buffer, alive_indices.len() as u32);
        push_u32(&mut buffer, self.world.food.len() as u32);
        push_u32(&mut buffer, self.world.poison.len() as u32);
        push_u32(&mut buffer, u32::from(self.halted));
        push_f32(&mut buffer, self.top_fitness_ever);
        push_f32(&mut buffer, self.last_average_lifespan);
        push_f32(&mut buffer, self.latest_average_complexity);

        for index in alive_indices {
            push_f32(&mut buffer, self.agents.positions[index].x);
            push_f32(&mut buffer, self.agents.positions[index].y);
            push_f32(&mut buffer, self.agents.energies[index]);
            push_f32(&mut buffer, self.agents.angles[index]);
            push_f32(&mut buffer, self.agents.cluster_ids[index] as f32);
        }
        for item in &self.world.food {
            push_f32(&mut buffer, item.x);
            push_f32(&mut buffer, item.y);
        }
        for item in &self.world.poison {
            push_f32(&mut buffer, item.x);
            push_f32(&mut buffer, item.y);
        }

        buffer
    }
}

fn push_u32(buffer: &mut Vec<u8>, value: u32) {
    buffer.extend_from_slice(&value.to_le_bytes());
}

fn push_f32(buffer: &mut Vec<u8>, value: f32) {
    buffer.extend_from_slice(&value.to_le_bytes());
}

fn random_point(rng: &mut SmallRng) -> Vec2 {
    Vec2::new(
        rng.random_range(0.0..WORLD_WIDTH),
        rng.random_range(0.0..WORLD_HEIGHT),
    )
}

fn fast_tanh(value: f32) -> f32 {
    value.tanh()
}

fn round2(value: f32) -> f32 {
    (value * 100.0).round() / 100.0
}

fn recordings_dir() -> PathBuf {
    PathBuf::from(RECORDINGS_DIR)
}

fn load_recording(recording_id: &str) -> Result<RecordingFile, String> {
    let path = recordings_dir().join(format!("{recording_id}.json"));
    let payload = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&payload).map_err(|error| error.to_string())
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}
