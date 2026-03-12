from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Dict, Iterable, List, Sequence, Tuple

import numpy as np


WORLD_WIDTH = 800
WORLD_HEIGHT = 800
WORLD_DIAGONAL = math.sqrt(WORLD_WIDTH**2 + WORLD_HEIGHT**2)


@dataclass(slots=True)
class Consumable:
    id: int
    kind: str
    position: np.ndarray

    def as_payload(self) -> dict[str, float]:
        return {"x": float(self.position[0]), "y": float(self.position[1])}


class SpatialHash:
    def __init__(self, width: int, height: int, cell_size: int) -> None:
        self.width = width
        self.height = height
        self.cell_size = cell_size
        self.cols = math.ceil(width / cell_size)
        self.rows = math.ceil(height / cell_size)
        self.buckets: Dict[Tuple[int, int], List[Consumable]] = {}

    def rebuild(self, items: Iterable[Consumable]) -> None:
        self.buckets.clear()
        for item in items:
            key = self.cell_for(item.position)
            self.buckets.setdefault(key, []).append(item)

    def cell_for(self, position: np.ndarray) -> Tuple[int, int]:
        return (
            int(position[0] // self.cell_size) % self.cols,
            int(position[1] // self.cell_size) % self.rows,
        )

    def nearby(self, position: np.ndarray, radius: int = 1) -> list[Consumable]:
        cell_x, cell_y = self.cell_for(position)
        candidates: list[Consumable] = []
        for dx in range(-radius, radius + 1):
            for dy in range(-radius, radius + 1):
                key = ((cell_x + dx) % self.cols, (cell_y + dy) % self.rows)
                candidates.extend(self.buckets.get(key, []))
        return candidates

    def nearest(
        self,
        position: np.ndarray,
        width: float,
        height: float,
    ) -> tuple[Consumable | None, float, np.ndarray]:
        origin_cell = self.cell_for(position)
        best_item: Consumable | None = None
        best_distance_sq = float("inf")
        best_delta = np.zeros(2, dtype=np.float32)

        max_radius = max(self.cols, self.rows)
        for radius in range(max_radius):
            found_in_ring = False
            x_min = origin_cell[0] - radius
            x_max = origin_cell[0] + radius
            y_min = origin_cell[1] - radius
            y_max = origin_cell[1] + radius

            for cell_x in range(x_min, x_max + 1):
                for cell_y in range(y_min, y_max + 1):
                    if radius > 0 and abs(cell_x - origin_cell[0]) < radius and abs(cell_y - origin_cell[1]) < radius:
                        continue
                    key = (cell_x % self.cols, cell_y % self.rows)
                    bucket = self.buckets.get(key)
                    if not bucket:
                        continue
                    found_in_ring = True
                    for item in bucket:
                        delta = toroidal_delta(position, item.position, width, height)
                        distance_sq = float(delta[0] ** 2 + delta[1] ** 2)
                        if distance_sq < best_distance_sq:
                            best_item = item
                            best_distance_sq = distance_sq
                            best_delta = delta

            if best_item is not None and (radius + 1) * self.cell_size > math.sqrt(best_distance_sq):
                break
            if radius > 2 and best_item is not None and not found_in_ring:
                break

        return best_item, math.sqrt(best_distance_sq) if best_item is not None else WORLD_DIAGONAL, best_delta


class NeuralNetwork:
    def __init__(self, layer_sizes: Sequence[int], weights: list[np.ndarray], biases: list[np.ndarray]) -> None:
        self.layer_sizes = tuple(layer_sizes)
        self.weights = weights
        self.biases = biases

    @classmethod
    def random(cls, rng: np.random.Generator, layer_sizes: Sequence[int]) -> "NeuralNetwork":
        weights = []
        biases = []
        for input_size, output_size in zip(layer_sizes[:-1], layer_sizes[1:]):
            scale = math.sqrt(2.0 / (input_size + output_size))
            weights.append(rng.normal(0.0, scale, size=(output_size, input_size)).astype(np.float32))
            biases.append(rng.normal(0.0, scale, size=(output_size,)).astype(np.float32))
        return cls(layer_sizes, weights, biases)

    def forward(self, inputs: np.ndarray) -> np.ndarray:
        activations = inputs.astype(np.float32)
        last_index = len(self.weights) - 1
        for index, (weight, bias) in enumerate(zip(self.weights, self.biases)):
            activations = weight @ activations + bias
            activations = np.tanh(activations) if index == last_index else leaky_tanh(activations)
        return activations

    def crossover(self, other: "NeuralNetwork", rng: np.random.Generator) -> "NeuralNetwork":
        new_weights: list[np.ndarray] = []
        new_biases: list[np.ndarray] = []
        for left, right in zip(self.weights, other.weights):
            mask = rng.random(left.shape) > 0.5
            new_weights.append(np.where(mask, left, right).astype(np.float32))
        for left, right in zip(self.biases, other.biases):
            mask = rng.random(left.shape) > 0.5
            new_biases.append(np.where(mask, left, right).astype(np.float32))
        return NeuralNetwork(self.layer_sizes, new_weights, new_biases)

    def mutate(
        self,
        rng: np.random.Generator,
        mutation_rate: float,
        mutation_scale: float = 0.2,
    ) -> None:
        for tensor in [*self.weights, *self.biases]:
            mask = rng.random(tensor.shape) < mutation_rate
            tensor[mask] += rng.normal(0.0, mutation_scale, size=int(mask.sum())).astype(np.float32)


@dataclass(slots=True)
class Agent:
    id: int
    position: np.ndarray
    velocity: np.ndarray
    angle: float
    energy: float
    brain: NeuralNetwork
    age: int = 0
    fitness: float = 0.0
    food_eaten: int = 0
    poison_hits: int = 0
    alive: bool = True

    max_energy: float = 160.0
    max_speed: float = 7.0
    drag: float = 0.9
    turn_rate: float = 4.2
    acceleration: float = 16.0
    idle_energy_loss: float = 0.7
    motion_energy_loss: float = 0.12

    def apply_controls(self, inputs: np.ndarray, dt: float) -> None:
        turn_signal, thrust_signal = self.brain.forward(inputs)
        self.angle += float(turn_signal) * self.turn_rate * dt

        thrust = (float(thrust_signal) + 1.0) * 0.5
        direction = np.array([math.cos(self.angle), math.sin(self.angle)], dtype=np.float32)
        self.velocity = self.velocity * self.drag + direction * thrust * self.acceleration * dt

        speed = float(np.linalg.norm(self.velocity))
        if speed > self.max_speed:
            self.velocity *= self.max_speed / speed
            speed = self.max_speed

        self.position += self.velocity
        self.position[0] %= WORLD_WIDTH
        self.position[1] %= WORLD_HEIGHT

        energy_cost = self.idle_energy_loss + speed * self.motion_energy_loss
        self.energy = max(0.0, self.energy - energy_cost)
        self.age += 1
        self.fitness = float(self.age + self.food_eaten * 90 - self.poison_hits * 55 + self.energy * 0.35)
        self.alive = self.energy > 0.0

    def as_payload(self) -> dict[str, float | int]:
        return {
            "id": self.id,
            "x": float(self.position[0]),
            "y": float(self.position[1]),
            "vx": float(self.velocity[0]),
            "vy": float(self.velocity[1]),
            "angle": float(self.angle),
            "energy": float(self.energy),
            "age": self.age,
            "fitness": round(self.fitness, 2),
        }


@dataclass(slots=True)
class GenerationStat:
    generation: int
    average_lifespan: float
    max_fitness: float

    def as_payload(self) -> dict[str, float | int]:
        return {
            "generation": self.generation,
            "average_lifespan": round(self.average_lifespan, 2),
            "max_fitness": round(self.max_fitness, 2),
        }


class Environment:
    def __init__(self, rng: np.random.Generator) -> None:
        self.rng = rng
        self.width = WORLD_WIDTH
        self.height = WORLD_HEIGHT
        self.food_target = 180
        self.poison_target = 120
        self.food_energy = 34.0
        self.poison_damage = 48.0
        self.collision_radius = 14.0
        self.food: dict[int, Consumable] = {}
        self.poison: dict[int, Consumable] = {}
        self.food_hash = SpatialHash(self.width, self.height, cell_size=64)
        self.poison_hash = SpatialHash(self.width, self.height, cell_size=64)
        self._next_consumable_id = 0
        self.reset_consumables()

    def reset_consumables(self) -> None:
        self.food.clear()
        self.poison.clear()
        self._spawn_until("food", self.food_target)
        self._spawn_until("poison", self.poison_target)
        self._rebuild_hashes()

    def _spawn_until(self, kind: str, target_size: int) -> None:
        registry = self.food if kind == "food" else self.poison
        while len(registry) < target_size:
            position = np.array(
                [self.rng.uniform(0, self.width), self.rng.uniform(0, self.height)],
                dtype=np.float32,
            )
            item = Consumable(id=self._next_consumable_id, kind=kind, position=position)
            registry[item.id] = item
            self._next_consumable_id += 1

    def _rebuild_hashes(self) -> None:
        self.food_hash.rebuild(self.food.values())
        self.poison_hash.rebuild(self.poison.values())

    def maintain_targets(self) -> None:
        self._spawn_until("food", self.food_target)
        self._spawn_until("poison", self.poison_target)
        self._rebuild_hashes()

    def sample_sensors(self, agent: Agent) -> np.ndarray:
        _, food_distance, food_delta = self.food_hash.nearest(agent.position, self.width, self.height)
        _, poison_distance, poison_delta = self.poison_hash.nearest(agent.position, self.width, self.height)

        heading = np.array([math.cos(agent.angle), math.sin(agent.angle)], dtype=np.float32)
        food_bearing = signed_angle(heading, food_delta) / math.pi
        poison_bearing = signed_angle(heading, poison_delta) / math.pi

        return np.array(
            [
                food_distance / WORLD_DIAGONAL,
                poison_distance / WORLD_DIAGONAL,
                agent.energy / agent.max_energy,
                food_bearing,
                poison_bearing,
            ],
            dtype=np.float32,
        )

    def resolve_collisions(self, agent: Agent) -> None:
        collision_radius_sq = self.collision_radius**2
        consumed_food: list[int] = []
        touched_poison: list[int] = []

        for item in self.food_hash.nearby(agent.position):
            delta = toroidal_delta(agent.position, item.position, self.width, self.height)
            if float(delta[0] ** 2 + delta[1] ** 2) <= collision_radius_sq:
                consumed_food.append(item.id)

        for item in self.poison_hash.nearby(agent.position):
            delta = toroidal_delta(agent.position, item.position, self.width, self.height)
            if float(delta[0] ** 2 + delta[1] ** 2) <= collision_radius_sq:
                touched_poison.append(item.id)

        if consumed_food:
            agent.food_eaten += len(consumed_food)
            agent.energy = min(agent.max_energy, agent.energy + self.food_energy * len(consumed_food))
            for item_id in consumed_food:
                self.food.pop(item_id, None)

        if touched_poison:
            agent.poison_hits += len(touched_poison)
            agent.energy = max(0.0, agent.energy - self.poison_damage * len(touched_poison))
            for item_id in touched_poison:
                self.poison.pop(item_id, None)

        if consumed_food or touched_poison:
            self.maintain_targets()
            agent.alive = agent.energy > 0.0

    def as_payload(self) -> dict[str, list[dict[str, float]]]:
        return {
            "food": [item.as_payload() for item in self.food.values()],
            "poison": [item.as_payload() for item in self.poison.values()],
        }


class SimulationEngine:
    def __init__(self, population_size: int = 220) -> None:
        self.population_size = population_size
        self.rng = np.random.default_rng(seed=7)
        self.environment = Environment(self.rng)
        self.generation = 1
        self.tick = 0
        self.dt = 1.0 / 30.0
        self.network_shape = (5, 10, 8, 2)
        self.mutation_rate = 0.05
        self.history: list[GenerationStat] = []
        self.last_average_lifespan = 0.0
        self.top_fitness_ever = 0.0
        self.population: list[Agent] = self._spawn_initial_population()

    def _spawn_initial_population(self) -> list[Agent]:
        return [self._random_agent(agent_id=index) for index in range(self.population_size)]

    def _random_agent(self, agent_id: int, brain: NeuralNetwork | None = None) -> Agent:
        position = np.array(
            [self.rng.uniform(0, WORLD_WIDTH), self.rng.uniform(0, WORLD_HEIGHT)],
            dtype=np.float32,
        )
        velocity = np.zeros(2, dtype=np.float32)
        network = brain or NeuralNetwork.random(self.rng, self.network_shape)
        return Agent(
            id=agent_id,
            position=position,
            velocity=velocity,
            angle=float(self.rng.uniform(-math.pi, math.pi)),
            energy=110.0,
            brain=network,
        )

    def step(self) -> dict[str, object]:
        self.tick += 1
        alive_agents = 0
        generation_best = 0.0

        for agent in self.population:
            if not agent.alive:
                continue
            inputs = self.environment.sample_sensors(agent)
            agent.apply_controls(inputs, self.dt)
            self.environment.resolve_collisions(agent)
            generation_best = max(generation_best, agent.fitness)
            if agent.alive:
                alive_agents += 1

        self.top_fitness_ever = max(self.top_fitness_ever, generation_best)

        if alive_agents == 0:
            self._advance_generation()

        return self.snapshot()

    def _advance_generation(self) -> None:
        ranked = sorted(self.population, key=lambda agent: agent.age, reverse=True)
        elite_count = max(2, math.ceil(len(ranked) * 0.1))
        elites = ranked[:elite_count]

        average_lifespan = sum(agent.age for agent in ranked) / len(ranked)
        max_fitness = max(agent.fitness for agent in ranked)
        self.last_average_lifespan = average_lifespan
        self.history.append(
            GenerationStat(
                generation=self.generation,
                average_lifespan=average_lifespan,
                max_fitness=max_fitness,
            )
        )
        self.history = self.history[-120:]

        new_population: list[Agent] = []
        for agent_id in range(self.population_size):
            parent_a, parent_b = self.rng.choice(elites, size=2, replace=True)
            child_brain = parent_a.brain.crossover(parent_b.brain, self.rng)
            child_brain.mutate(self.rng, self.mutation_rate)
            new_population.append(self._random_agent(agent_id, brain=child_brain))

        self.generation += 1
        self.population = new_population
        self.environment.reset_consumables()

    def snapshot(self) -> dict[str, object]:
        alive_agents = [agent for agent in self.population if agent.alive]
        environment_state = self.environment.as_payload()
        current_max_fitness = max((agent.fitness for agent in self.population), default=0.0)
        average_energy = (
            sum(agent.energy for agent in alive_agents) / len(alive_agents) if alive_agents else 0.0
        )

        return {
            "tick": self.tick,
            "generation": self.generation,
            "agents": [agent.as_payload() for agent in alive_agents],
            "food": environment_state["food"],
            "poison": environment_state["poison"],
            "stats": {
                "alive": len(alive_agents),
                "population": self.population_size,
                "average_energy": round(average_energy, 2),
                "average_lifespan": round(self.last_average_lifespan, 2),
                "max_fitness": round(max(current_max_fitness, self.top_fitness_ever), 2),
                "top_fitness_ever": round(self.top_fitness_ever, 2),
            },
            "history": [entry.as_payload() for entry in self.history],
        }


def toroidal_delta(origin: np.ndarray, target: np.ndarray, width: float, height: float) -> np.ndarray:
    delta = target - origin
    if abs(delta[0]) > width / 2:
        delta[0] -= math.copysign(width, delta[0])
    if abs(delta[1]) > height / 2:
        delta[1] -= math.copysign(height, delta[1])
    return delta.astype(np.float32)


def signed_angle(heading: np.ndarray, target_delta: np.ndarray) -> float:
    if float(np.linalg.norm(target_delta)) < 1e-6:
        return 0.0
    target_direction = target_delta / np.linalg.norm(target_delta)
    dot = float(np.clip(np.dot(heading, target_direction), -1.0, 1.0))
    determinant = float(heading[0] * target_direction[1] - heading[1] * target_direction[0])
    return math.atan2(determinant, dot)


def leaky_tanh(values: np.ndarray) -> np.ndarray:
    tanh_values = np.tanh(values)
    return np.where(values > 0, tanh_values, tanh_values * 0.3).astype(np.float32)
