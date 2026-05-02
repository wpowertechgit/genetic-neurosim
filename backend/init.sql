-- Initialize the table as per the premadegraph integration contract
CREATE TABLE IF NOT EXISTS player_clusters (
    cluster_id INT PRIMARY KEY,
    size_ratio DOUBLE PRECISION NOT NULL,
    mean_opscore DOUBLE PRECISION NOT NULL,
    opscore_stddev DOUBLE PRECISION NOT NULL,
    cohesion DOUBLE PRECISION NOT NULL,
    internal_edge_ratio DOUBLE PRECISION NOT NULL
);

-- Seed data for testing the "Apex vs Resilient" scenario
INSERT INTO player_clusters (cluster_id, size_ratio, mean_opscore, opscore_stddev, cohesion, internal_edge_ratio)
VALUES 
    (1, 0.1, 0.9, 0.05, 0.8, 0.9), -- Small Elite "Apex"
    (2, 0.4, 0.5, 0.15, 0.6, 0.7), -- Large Resilient
    (3, 0.25, 0.3, 0.2, 0.4, 0.5), -- Volatile
    (4, 0.25, 0.6, 0.1, 0.7, 0.8)  -- Balanced
ON CONFLICT (cluster_id) DO NOTHING;
