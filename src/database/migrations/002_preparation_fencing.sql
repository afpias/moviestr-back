ALTER TABLE preparation_operations ADD COLUMN lease_token uuid;
CREATE UNIQUE INDEX preparation_one_active_generation ON preparation_operations(kind,target_id,generation) WHERE state IN ('pending','working');
