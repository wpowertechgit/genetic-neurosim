const HEADER_BYTES = 36;
const AGENT_STRIDE = 5;
const POINT_STRIDE = 2;

export type BinaryFrame = {
  generation: number;
  tick: number;
  agentCount: number;
  foodCount: number;
  poisonCount: number;
  halted: boolean;
  topFitness: number;
  averageLifespan: number;
  averageComplexity: number;
  agents: Float32Array; // [x, y, energy, angle, cluster_id] * agentCount
  food: Float32Array;
  poison: Float32Array;
};

export function parseBinaryFrame(buffer: ArrayBuffer): BinaryFrame {
  const view = new DataView(buffer);
  const generation = view.getUint32(0, true);
  const tick = view.getUint32(4, true);
  const agentCount = view.getUint32(8, true);
  const foodCount = view.getUint32(12, true);
  const poisonCount = view.getUint32(16, true);
  const halted = view.getUint32(20, true) === 1;
  const topFitness = view.getFloat32(24, true);
  const averageLifespan = view.getFloat32(28, true);
  const averageComplexity = view.getFloat32(32, true);

  // The Rust backend packs a fixed 36-byte header, then raw float tuples.
  // Every agent record is 4 floats (16 bytes): x, y, energy, angle.
  // Every food/poison record is 2 floats (8 bytes): x, y.
  const agents = new Float32Array(buffer, HEADER_BYTES, agentCount * AGENT_STRIDE);
  const foodOffset = HEADER_BYTES + agentCount * AGENT_STRIDE * Float32Array.BYTES_PER_ELEMENT;
  const food = new Float32Array(buffer, foodOffset, foodCount * POINT_STRIDE);
  const poisonOffset = foodOffset + foodCount * POINT_STRIDE * Float32Array.BYTES_PER_ELEMENT;
  const poison = new Float32Array(buffer, poisonOffset, poisonCount * POINT_STRIDE);

  return {
    generation,
    tick,
    agentCount,
    foodCount,
    poisonCount,
    halted,
    topFitness,
    averageLifespan,
    averageComplexity,
    agents,
    food,
    poison,
  };
}
