CREATE TABLE guest_sessions (
 id uuid PRIMARY KEY, token_hash text NOT NULL UNIQUE,
 expires_at bigint NOT NULL, last_activity bigint NOT NULL
);
CREATE TABLE prepared_movies (id uuid PRIMARY KEY, tmdb_id text NOT NULL, data jsonb NOT NULL, created_at bigint NOT NULL);
CREATE TABLE solo_games (
 id uuid PRIMARY KEY, owner uuid NOT NULL REFERENCES guest_sessions(id) ON DELETE CASCADE,
 data jsonb NOT NULL, movie_id uuid REFERENCES prepared_movies(id), updated_at bigint NOT NULL
);
CREATE TABLE rooms (id text PRIMARY KEY, data jsonb NOT NULL, status text NOT NULL CHECK(status IN ('waiting','loading','playing','finished','closed','error')), version bigint NOT NULL, updated_at bigint NOT NULL);
CREATE TABLE room_players (
 room_id text REFERENCES rooms(id) ON DELETE CASCADE, player_id uuid REFERENCES guest_sessions(id) ON DELETE CASCADE,
 nickname_normalized text NOT NULL, active boolean NOT NULL, data jsonb NOT NULL,
 PRIMARY KEY(room_id,player_id)
);
CREATE UNIQUE INDEX room_unique_nickname ON room_players(room_id,nickname_normalized) WHERE active;
CREATE TABLE room_rounds (
 room_id text REFERENCES rooms(id) ON DELETE CASCADE, round_id uuid NOT NULL UNIQUE,
 round_number integer NOT NULL CHECK(round_number BETWEEN 0 AND 50), movie_id uuid REFERENCES prepared_movies(id),
 deadline bigint, generation integer NOT NULL, PRIMARY KEY(room_id,round_number)
);
CREATE TABLE player_round_progress (
 room_id text NOT NULL, player_id uuid NOT NULL, round_id uuid NOT NULL REFERENCES room_rounds(round_id) ON DELETE CASCADE,
 frame_index integer NOT NULL CHECK(frame_index BETWEEN 0 AND 4), data jsonb NOT NULL,
 PRIMARY KEY(room_id,player_id,round_id), FOREIGN KEY(room_id,player_id) REFERENCES room_players(room_id,player_id) ON DELETE CASCADE
);
CREATE TABLE room_used_movies (room_id text REFERENCES rooms(id) ON DELETE CASCADE, movie_id text NOT NULL, PRIMARY KEY(room_id,movie_id));
CREATE TABLE command_deduplication (
 owner uuid REFERENCES guest_sessions(id) ON DELETE CASCADE, scope text NOT NULL, key text NOT NULL,
 request_hash text NOT NULL, outcome jsonb NOT NULL, aggregate_id text, created_at bigint NOT NULL,
 PRIMARY KEY(owner,scope,key)
);
CREATE INDEX command_aggregate ON command_deduplication(aggregate_id);
CREATE TABLE preparation_operations (
 id uuid PRIMARY KEY, owner uuid REFERENCES guest_sessions(id) ON DELETE CASCADE, target_id text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('solo','room')), generation integer NOT NULL,
 state text NOT NULL CHECK(state IN ('pending','working','ready','error')), lease_until bigint, error text, created_at bigint NOT NULL
);
CREATE INDEX preparation_pending ON preparation_operations(state,lease_until);
CREATE TABLE realtime_tickets (token_hash text PRIMARY KEY, owner uuid REFERENCES guest_sessions(id) ON DELETE CASCADE, room_id text, expires_at bigint NOT NULL);
CREATE TABLE event_outbox (id bigserial PRIMARY KEY, aggregate_id text NOT NULL, version bigint NOT NULL, delivered boolean NOT NULL DEFAULT false, created_at bigint NOT NULL);
CREATE TABLE provider_cache (key text PRIMARY KEY, data jsonb NOT NULL, expires_at bigint NOT NULL);
CREATE TABLE ocr_cache (key text PRIMARY KEY, text text NOT NULL, expires_at bigint NOT NULL);
CREATE INDEX rooms_lobby ON rooms(status,updated_at);
CREATE INDEX solo_owner ON solo_games(owner,updated_at);
