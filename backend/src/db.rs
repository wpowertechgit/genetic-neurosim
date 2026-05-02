use crate::simulation::{ClusterProfile, ControlConfig};
use sqlx::postgres::PgPoolOptions;
use std::env;

pub struct Database {
    pool: sqlx::PgPool,
}

impl Database {
    pub async fn connect() -> Result<Self, sqlx::Error> {
        let database_url = env::var("DATABASE_URL")
            .unwrap_or_else(|_| "postgres://postgres:postgres@localhost/premadegraph".to_string());
        
        let pool = PgPoolOptions::new()
            .max_connections(5)
            .connect(&database_url)
            .await?;
        
        Ok(Self { pool })
    }

    pub async fn fetch_simulation_config(&self) -> Result<ControlConfig, sqlx::Error> {
        // Query to fetch clusters and their metrics
        // Assuming table name is 'player_clusters' as per premadegraph integration context
        let clusters = sqlx::query_as!(
            ClusterRecord,
            r#"
            SELECT 
                cluster_id::TEXT as id,
                size_ratio as "size_ratio!",
                mean_opscore as "mean_opscore!",
                opscore_stddev as "opscore_stddev!",
                cohesion as "cohesion!",
                internal_edge_ratio as "internal_edge_ratio!"
            FROM player_clusters
            "#
        )
        .fetch_all(&self.pool)
        .await?;

        let profiles = clusters
            .into_iter()
            .map(|r| ClusterProfile {
                id: r.id,
                size_ratio: r.size_ratio as f32,
                mean_opscore: r.mean_opscore as f32,
                opscore_stddev: r.opscore_stddev as f32,
                cohesion: r.cohesion as f32,
                internal_edge_ratio: r.internal_edge_ratio as f32,
            })
            .collect();

        let mut config = ControlConfig::default();
        config.clusters = profiles;
        
        Ok(config)
    }
}

struct ClusterRecord {
    id: String,
    size_ratio: f64,
    mean_opscore: f64,
    opscore_stddev: f64,
    cohesion: f64,
    internal_edge_ratio: f64,
}
