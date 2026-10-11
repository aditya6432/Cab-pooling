-- Member 2 indexes - each one serves a named query / workflow (measured in docs/MODULE_DESIGN_M2.md)
-- seat counting: covering partial index -> index-only scan of confirmed seats per ride
CREATE INDEX member_confirmed_seats_idx ON ride_member (ride_id) INCLUDE (seats_taken) WHERE status = 'confirmed';
-- (a (ride_id, joined_at) index for the waitlist queue was benchmarked and REMOVED: the primary key already
--  answers it in 0.014 ms, the extra index gained nothing)
-- creator inbox of pending requests is served by the partial UNIQUE index request_one_pending (ride_id, student_id) WHERE pending
-- "my requests"
CREATE INDEX request_student_idx        ON booking_request (student_id, created_at DESC);
-- my notification feed
CREATE INDEX event_student_idx          ON booking_event (student_id, created_at DESC);
-- supports the ON DELETE CASCADE foreign key from ride and "history of one ride" (not benchmarked separately)
CREATE INDEX event_ride_idx             ON booking_event (ride_id, event_id);
