mod simulation;

use std::{net::SocketAddr, sync::Arc, time::Duration};

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use futures::{SinkExt, StreamExt};
use serde::Serialize;
use simulation::{
    ConfigPatch, ControlConfig, GodModeResponse, SharedSimulation, Simulation, StatusResponse,
};
use tokio::sync::broadcast;
use tower_http::cors::{Any, CorsLayer};

#[derive(Clone)]
struct AppState {
    simulation: SharedSimulation,
    frame_tx: broadcast::Sender<Arc<Vec<u8>>>,
}

#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
}

#[tokio::main]
async fn main() {
    let simulation = Simulation::shared(ControlConfig::default());
    let (frame_tx, _) = broadcast::channel::<Arc<Vec<u8>>>(32);
    let state = Arc::new(AppState {
        simulation,
        frame_tx,
    });

    tokio::spawn(simulation_loop(state.clone()));

    let app = Router::new()
        .route("/health", get(health))
        .route("/ws/simulation", get(ws_simulation))
        .route("/api/status", get(get_status))
        .route("/api/config", get(get_config).post(update_config))
        .route("/api/god-mode", post(god_mode))
        .with_state(state)
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any),
        );

    let address = SocketAddr::from(([127, 0, 0, 1], 8000));
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

async fn god_mode(State(state): State<Arc<AppState>>) -> Json<GodModeResponse> {
    let mut simulation = state.simulation.write();
    Json(simulation.kill_half_population())
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
