ALTER TABLE rooms DROP CONSTRAINT rooms_status_check;
ALTER TABLE rooms ADD CONSTRAINT rooms_status_check CHECK(status IN ('waiting','loading','playing','round-result','finished','closed','error'));
