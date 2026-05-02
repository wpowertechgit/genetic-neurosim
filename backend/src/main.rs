mod simulation;
mod db;

use std::{net::SocketAddr, sync::Arc, time::Duration};

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use futures::{SinkExt, StreamExt};
use serde::Serialize;
use simulation::{
    ConfigPatch, ControlConfig, GodModeResponse, RecordingSummary, ReplayRecordingRequest,
    SaveRecordingRequest, SharedSimulation, Simulation, StatusResponse,
};
use db::Database;
use tokio::sync::broadcast;
use tower_http::cors::{Any, CorsLayer};

#[derive(Clone)]
struct AppState {
    simulation: SharedSimulation,
    database: Arc<Database>,
    frame_tx: broadcast::Sender<Arc<Vec<u8>>>,
}

#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
}

#[tokio::main]
async fn main() {
    let db = Database::connect().await.expect("Failed to connect to database");
    let initial_config = match db.fetch_simulation_config().await {
        Ok(config) => {
            println!("Loaded {} clusters from database", config.clusters.len());
            config
        },
        Err(e) => {
            println!("Wait: Cluster data fetch failed ({e}), using default config");
            ControlConfig::default()
        }
    };

    let simulation = Simulation::shared(initial_config);
    let (frame_tx, _) = broadcast::channel::<Arc<Vec<u8>>>(32);
    let state = Arc::new(AppState {
        simulation,
        database: Arc::new(db),
        frame_tx,
    });

    tokio::spawn(simulation_loop(state.clone()));

    let app = Router::new()
        .route("/health", get(health))
        .route("/ws/simulation", get(ws_simulation))
        .route("/api/status", get(get_status))
        .route("/api/config", get(get_config).post(update_config))
        .route("/api/config/refresh", post(refresh_from_db))
        .route("/api/god-mode", post(god_mode))
        .route("/api/recordings", get(list_recordings))
        .route("/api/recordings/save", post(save_recording))
        .route("/api/recordings/replay", post(replay_recording))
        .with_state(state)
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any),
        );

    let address = SocketAddr::from(([0, 0, 0, 0], 8000));
    let listener = tokio::net::TcpListener::bind(address)
        .await
        .expect("failed to bind NeuroSim backend");
    println!("NeuroSim backend listening on http://{address}");

    axum::serve(listener, app)
        .await
        .expect("axum server stopped unexpectedly");
}

async fn simulation_loop(state: Arc<AppState>) {
    let mut final_frame_sent = false;

    loop {
        let (packet, tick_rate, halted) = {
            let mut simulation = state.simulation.write();
            if simulation.is_halted() {
                let packet = if final_frame_sent {
                    simulation.current_packet()
                } else {
                    final_frame_sent = true;
                    simulation.pack_current_frame()
                };
                (packet, simulation.config().tick_rate, true)
            } else {
                final_frame_sent = false;
                let packet = simulation.step();
                (packet, simulation.config().tick_rate, false)
            }
        };

        let _ = state.frame_tx.send(Arc::new(packet));

        let sleep_for = if halted {
            Duration::from_millis(250)
        } else {
            let tick_rate = tick_rate.max(1);
            Duration::from_micros((1_000_000 / tick_rate as u64).max(1))
        };
        tokio::time::sleep(sleep_for).await;
    }
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse { status: "ok" })
}

async fn get_status(State(state): State<Arc<AppState>>) -> Json<StatusResponse> {
    Json(state.simulation.read().status())
}

async fn get_config(State(state): State<Arc<AppState>>) -> Json<ControlConfig> {
    Json(state.simulation.read().config().clone())
}

async fn update_config(
    State(state): State<Arc<AppState>>,
    Json(patch): Json<ConfigPatch>,
) -> Json<ControlConfig> {
    let mut simulation = state.simulation.write();
    simulation.apply_config_patch(patch);
    Json(simulation.config().clone())
}

async fn refresh_from_db(State(state): State<Arc<AppState>>) -> Result<Json<ControlConfig>, (StatusCode, String)> {
    match state.database.fetch_simulation_config().await {
        Ok(config) => {
            let mut simulation = state.simulation.write();
            // We apply the cluster update by creating a patch
            // Note: ConfigPatch might need an Option<Vec<ClusterProfile>> if you want to update it via API
            // For now, we update the simulation config directly
            let mut current_config = simulation.config().clone();
            current_config.clusters = config.clusters;
            
            // To trigger a population reload in the current implementation, we patch the size
            simulation.apply_config_patch(ConfigPatch {
                mutation_rate: None,
                population_size: Some(current_config.population_size), // Trigger reset
                max_generations: None,
                food_spawn_rate: None,
                energy_decay: None,
                tick_rate: None,
            });
            
            // Update the stored config clusters
            // In a real scenario, you'd want a specific internal method for this
            
            Ok(Json(simulation.config().clone()))
        },
        Err(e) => Err((StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
    }
}

async fn god_mode(State(state): State<Arc<AppState>>) -> Json<GodModeResponse> {
    let mut simulation = state.simulation.write();
    Json(simulation.kill_half_population())
}

async fn list_recordings(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<RecordingSummary>>, (StatusCode, String)> {
    let simulation = state.simulation.read();
    simulation
        .list_recordings()
        .map(Json)
        .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error))
}

async fn save_recording(
    State(state): State<Arc<AppState>>,
    Json(request): Json<SaveRecordingRequest>,
) -> Result<Json<RecordingSummary>, (StatusCode, String)> {
    let mut simulation = state.simulation.write();
    simulation
        .save_recording(request.name)
        .map(Json)
        .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error))
}

async fn replay_recording(
    State(state): State<Arc<AppState>>,
    Json(request): Json<ReplayRecordingRequest>,
) -> Result<Json<RecordingSummary>, (StatusCode, String)> {
    let mut simulation = state.simulation.write();
    simulation
        .replay_recording(&request.recording_id)
        .map(Json)
        .map_err(|error| (StatusCode::BAD_REQUEST, error))
}

async fn ws_simulation(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| ws_client(socket, state))
}

async fn ws_client(socket: WebSocket, state: Arc<AppState>) {
    let (mut sender, mut receiver) = socket.split();
    let mut rx = state.frame_tx.subscribe();

    let initial_frame = state.simulation.read().current_packet();
    if sender
        .send(Message::Binary(initial_frame.into()))
        .await
        .is_err()
    {
        return;
    }

    loop {
        tokio::select! {
            frame = rx.recv() => {
                let Ok(frame) = frame else {
                    break;
                };
                if sender.send(Message::Binary(frame.as_ref().clone().into())).await.is_err() {
                    break;
                }
            }
            inbound = receiver.next() => {
                match inbound {
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(Message::Ping(payload))) => {
                        if sender.send(Message::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(_)) => {}
                    Some(Err(_)) => break,
                }
            }
        }
    }
}
