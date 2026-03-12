Role: You are a Lead Research Engineer specializing in Artificial Life, Machine Learning, and High-Performance Web Architectures.
Objective: Build the MVP for "NeuroSim," a full-stack, real-time evolutionary simulation where agents driven by simple neural networks learn to survive via genetic algorithms.

Phase 1: Backend Physics & Neural Engine (Python/FastAPI/NumPy)

Initialize a FastAPI application with a WebSocket endpoint at /ws/simulation.

Create an Environment class that manages an 800x800 2D grid. The environment should randomly spawn "Food" (adds energy) and "Poison" (drains energy).

Create an Agent class. Each agent has:

Position (X, Y), Velocity, and Energy.

A Feed-Forward Neural Network (built from scratch using NumPy, no PyTorch/TensorFlow).

Inputs: Distance to nearest food, distance to nearest poison, current energy.

Outputs: Rotation angle, thrust/speed.

Implement a game loop that runs at 30 ticks per second:

Update all agent positions based on their neural network outputs.

Handle collisions (eating food/poison).

Kill agents when energy reaches 0.

Implement the Genetic Algorithm: When all agents die, take the top 10% (those who lived longest), cross over their neural network weights, apply a 5% mutation rate, and spawn a new generation.

Phase 2: Data Streaming (WebSockets)

Within the continuous backend game loop, serialize the current state of the simulation (Agent positions, Agent energy levels, Food positions, Poison positions, Current Generation number, and Top Fitness score).

Broadcast this serialized JSON state via the WebSocket to any connected client.

Phase 3: The Frontend Arena (Next.js & HTML5 Canvas)

Initialize a Next.js application.

Create a dashboard layout. The main component is an HTML5 <canvas> element (or a WebGL canvas) that connects to the backend WebSocket.

Rendering Logic: On every WebSocket message, clear the canvas and redraw the current frame:

Draw Food as glowing green dots.

Draw Poison as glowing red dots.

Draw Agents as triangles (pointing in their direction of velocity).

Color-code the Agents based on their energy levels (e.g., bright white for high energy, fading to dark gray as they die).

Leave a slight fading opacity trail behind the agents to visualize their movement paths.

Phase 4: Real-Time Analytics (Chart.js)

Beside or below the simulation canvas, implement a real-time line chart using Chart.js or Recharts.

Track and graph the "Average Lifespan" and "Max Fitness" of the agents over each passing generation to visually prove that the AI is learning and evolving over time.

Execution Constraints:

Provide fully functional code for all files.

Do NOT use external machine learning libraries like PyTorch or Scikit-Learn; the neural network matrix multiplication must be written in raw Python/NumPy to demonstrate algorithmic understanding.

Include a README.md with instructions on how to install dependencies and run the backend and frontend simultaneously.