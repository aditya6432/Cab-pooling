-- Each index is justified by a query in server/src/queries.js
CREATE INDEX ride_open_time_idx   ON ride (depart_start, depart_end) WHERE status = 'open';   -- search (partial)
CREATE INDEX ride_route_time_idx  ON ride (origin_id, dest_id, depart_start);                  -- route analytics
CREATE INDEX ride_creator_idx     ON ride (creator_id, depart_start DESC);                     -- "my rides"
CREATE INDEX ride_stop_loc_idx    ON ride_stop (location_id);                                  -- via-stop matching
CREATE INDEX ride_member_student_idx ON ride_member (student_id, status);                      -- joined rides, seats
CREATE INDEX student_name_prefix_idx ON student (lower(full_name) text_pattern_ops);           -- name search
CREATE INDEX student_hostel_idx   ON student (hostel_id);                                      -- hostel league
CREATE INDEX session_student_idx  ON auth_session (student_id);                                -- logout-all
