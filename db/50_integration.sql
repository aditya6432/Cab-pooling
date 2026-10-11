-- =====================================================================
-- PoolUp — 50_integration.sql   (whole team)
-- ---------------------------------------------------------------------
-- Objects that only make sense once all five modules live in one
-- database. Nothing here duplicates a module's rules; it composes them.
--
--   v_student_overview     one row per student, one column group per module
--   fn_integrity_report()  cross-module invariants, each counted live
--                          (every count must be 0; shown on the Database
--                          page and asserted by the test suite)
-- =====================================================================

-- ---------------------------------------------------------------------
-- v_student_overview: the "student 360" (profile header, Database page)
--   M1 rides created / joined · M2 booking reliability ·
--   M3+M4 money position · M5 reputation
-- Every input is itself a view, so no number is stored twice.
-- ---------------------------------------------------------------------
CREATE VIEW v_student_overview AS
SELECT s.student_id,
       s.full_name,
       h.name                    AS hostel,
       rs.rides_created,                              -- M1  v_student_ride_stats
       rs.rides_joined,
       COALESCE(bs.bookings, 0)  AS bookings,         -- M2  v_student_booking_stats
       COALESCE(bs.no_shows, 0)  AS no_shows,
       bs.reliability_pct,
       mo.owes,                                       -- M4  v_student_money (over M3's expenses)
       mo.owed,
       mo.net                    AS money_net,
       mo.pending_out,
       mo.pending_in,
       rp.ratings_received,                           -- M5  v_student_reputation
       rp.bayes_score,
       rp.trust_score
FROM student s
JOIN hostel h                      ON h.hostel_id   = s.hostel_id
JOIN v_student_ride_stats rs       ON rs.student_id = s.student_id
LEFT JOIN v_student_booking_stats bs ON bs.student_id = s.student_id
JOIN v_student_money mo            ON mo.student_id = s.student_id
JOIN v_student_reputation rp       ON rp.student_id = s.student_id;

-- ---------------------------------------------------------------------
-- fn_integrity_report(): every invariant the five modules promise each
-- other, as a live count of violating rows. The rules are ENFORCED by the
-- constraints and triggers of each module; this function only PROVES that
-- the data really satisfies them (useful after bulk seeding, which runs
-- with poolup.seeding = 'on' and skips the clock-based trigger rules).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_integrity_report()
RETURNS TABLE (check_id TEXT, module TEXT, description TEXT, violations BIGINT)
LANGUAGE sql STABLE AS $$
    SELECT 'I1', 'M1+M2', 'Every ride''s creator holds a seat on it',
           (SELECT count(*) FROM ride r
             WHERE NOT EXISTS (SELECT 1 FROM ride_member m
                               WHERE m.ride_id = r.ride_id AND m.student_id = r.creator_id))
    UNION ALL
    SELECT 'I2', 'M2', 'No ride has more confirmed seats than its cab',
           (SELECT count(*) FROM v_ride_occupancy WHERE seats_left < 0)
    UNION ALL
    SELECT 'I3', 'M2', 'Upcoming ride status matches its seats (open has a free seat, full has none)',
           (SELECT count(*) FROM v_ride_occupancy
             WHERE depart_start > now()
               AND ((status = 'open' AND seats_left <= 0) OR (status = 'full' AND seats_left > 0)))
    UNION ALL
    SELECT 'I4', 'M2', 'Waitlists exist only on full rides',
           (SELECT count(*) FROM ride_waitlist w JOIN ride r USING (ride_id) WHERE r.status <> 'full')
    UNION ALL
    SELECT 'I5', 'M3', 'Every expense is split exactly (sum of shares = amount)',
           (SELECT count(*) FROM expense e
             WHERE e.amount <> (SELECT COALESCE(sum(s.share_amount), 0)
                                FROM expense_share s WHERE s.expense_id = e.expense_id))
    UNION ALL
    SELECT 'I6', 'M3', 'Expenses only on departed or completed rides, paid by a rider',
           (SELECT count(*) FROM expense e
              JOIN ride r ON r.ride_id = e.ride_id
              JOIN ride_member m ON m.ride_id = e.ride_id AND m.student_id = e.paid_by
             WHERE r.status NOT IN ('departed', 'completed') OR m.status <> 'confirmed')
    UNION ALL
    SELECT 'I7', 'M4', 'Every ride''s ledger sums to exactly zero',
           (SELECT count(*) FROM (SELECT ride_id FROM v_ride_balance
                                  GROUP BY ride_id HAVING sum(net) <> 0 OR sum(open) <> 0) x)
    UNION ALL
    SELECT 'I8', 'M3+M4', 'Expense ledger (M3 v_ride_ledger) and payment ledger (M4 v_ride_balance) agree',
           (SELECT count(*)
              FROM v_ride_ledger l
              FULL JOIN v_ride_balance b ON b.ride_id = l.ride_id AND b.student_id = l.student_id
             WHERE COALESCE(l.net, 0) <> COALESCE(b.net, 0))
    UNION ALL
    SELECT 'I9', 'M4', 'Nobody has been paid more than they were owed (no negative open debt flips)',
           (SELECT count(*) FROM v_ride_balance b
             WHERE b.paid - b.share < 0 AND b.open > 0          -- a debtor who ended up owed
                OR b.paid - b.share > 0 AND b.open < 0)         -- a creditor who ended up owing
    UNION ALL
    SELECT 'I10', 'M4', 'Net-off entries come in balanced mirrored pairs',
           (SELECT count(*) FROM (
               SELECT offset_group FROM payment WHERE method = 'offset'
               GROUP BY offset_group
               HAVING count(*) <> 2 OR min(amount) <> max(amount)
                   OR count(DISTINCT ride_id) <> 2) x)
    UNION ALL
    SELECT 'I11', 'M4', 'Every payment''s current status equals its latest history event',
           (SELECT count(*) FROM payment p
             WHERE p.status IS DISTINCT FROM (SELECT e.to_status FROM payment_event e
                                              WHERE e.payment_id = p.payment_id
                                              ORDER BY e.changed_at DESC, e.event_id DESC LIMIT 1))
    UNION ALL
    SELECT 'I12', 'M5', 'Ratings only on completed rides, between riders who both travelled',
           (SELECT count(*) FROM rating x
              JOIN ride r ON r.ride_id = x.ride_id
              JOIN ride_member a ON a.ride_id = x.ride_id AND a.student_id = x.rater_id
              JOIN ride_member b ON b.ride_id = x.ride_id AND b.student_id = x.ratee_id
             WHERE r.status <> 'completed' OR a.status <> 'confirmed' OR b.status <> 'confirmed'
                OR x.created_at > r.completed_at + fn_rating_window())
    UNION ALL
    SELECT 'I13', 'M5', 'At most 3 tags per rating, never against the rating''s sentiment',
           (SELECT count(*) FROM (
               SELECT m.ride_id, m.rater_id, m.ratee_id
               FROM rating_tag_map m
               JOIN rating x USING (ride_id, rater_id, ratee_id)
               JOIN rating_tag t ON t.tag_id = m.tag_id
               GROUP BY m.ride_id, m.rater_id, m.ratee_id, x.score
               HAVING count(*) > 3
                   OR bool_or(x.score = 5 AND t.sentiment = 'negative')
                   OR bool_or(x.score = 1 AND t.sentiment = 'positive')) x)
$$;
