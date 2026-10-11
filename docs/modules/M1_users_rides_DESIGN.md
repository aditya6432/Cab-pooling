# Module design - Users + Ride creation / search

> **Module deep-dive, written by Member 1 while building the module on its own.** In the integrated repository the files are numbered by layer (`db/1x` tables, `2x` logic, `3x` views, `4x` indexes, `db/queries/` named queries) and the references below have been updated to those names. Stand-in tables and the temporary `X-Student-Id` header mentioned in some passages were replaced at integration by the real tables and by Member 1's login; see `../INTEGRATION_NOTES.md`.


(Full formatted version with figures: `pdf/M1_PoolUp_Users_Rides_Module.pdf`.)

## 1. ER diagram
```mermaid
erDiagram
  HOSTEL ||--o{ STUDENT : "lives in"
  STUDENT ||--o{ AUTH_SESSION : has
  STUDENT ||--o{ RIDE : creates
  LOCATION ||--o{ RIDE : "origin"
  LOCATION ||--o{ RIDE : "destination"
  CAB_TYPE ||--o{ RIDE : uses
  RIDE ||--o{ RIDE_STOP : "has (weak)"
  LOCATION ||--o{ RIDE_STOP : "stop at"
  RIDE ||--o{ RIDE_STATUS_LOG : logs
  RIDE ||--o{ RIDE_MEMBER : "has (Member 2)"
  STUDENT ||--o{ RIDE_MEMBER : joins
  STUDENT { char13 student_id PK  varchar email UK  char10 phone UK  smallint hostel_id FK  text password_hash }
  RIDE { int ride_id PK  char13 creator_id FK  smallint origin_id FK  smallint dest_id FK  varchar cab_type FK  timestamptz depart_start  timestamptz depart_end  numeric distance_km  varchar status  timestamptz completed_at }
  RIDE_STOP { int ride_id PK_FK  smallint stop_seq PK  smallint location_id FK }
```

## 2. Normalization (3NF / BCNF)
- `student(student_id, full_name, email, phone, hostel_id, ...)`: candidate keys `student_id`, `email`, `phone`; every determinant is a key -> **BCNF**. Hostel *name* is not repeated per student: it lives in `hostel` (removes the transitive dependency student -> hostel_id -> name).
- `ride`: all attributes depend on `ride_id` only. `cab_type` attributes (seats, fares) are factored into `cab_type` (`ride -> cab_type -> max_seats` would otherwise be transitive). Location names/coordinates live in `location`.
- `ride_stop(ride_id, stop_seq, location_id)`: removes the multi-valued "stops" attribute (1NF); key `(ride_id, stop_seq)`, plus `UNIQUE(ride_id, location_id)`.
- **Deliberately derived, not stored:** seats left, fare per head, number of riders - computed from `ride_member` so they can never go stale. `distance_km` IS stored (a snapshot at creation) because location coordinates are static reference data and search needs it fast.

## 3. Business rules (all enforced in the database)
| Id | Rule | Mechanism |
|---|---|---|
| U1-U4 | BITS ID, email domain, phone, name formats | CHECK |
| U5-U7 | ID, email, phone unique | PK / UNIQUE |
| U8 | Hostel must exist | FK |
| R1 | Origin <> destination | CHECK (`ride_distinct_endpoints`) |
| R2-R3 | Window valid, <= 3 hours | CHECK |
| R4 | Valid cab / locations | FK |
| R5-R6 | No duplicate stops, <= 3 stops | UNIQUE + CHECK |
| R7-R8 | Start >= 15 min ahead, <= 60 days ahead | Trigger `ride_validate` |
| R9 | New ride starts `open` | Trigger |
| R10 | Creator cannot have two overlapping rides | Trigger + `FOR UPDATE` lock in `fn_create_ride` |
| R11 | Status flow: open<->full, open/full -> departed -> completed, open/full -> cancelled | Trigger `ride_status` (also writes `ride_status_log`) |
| R12 | Creator / route / cab frozen after creation | Trigger `ride_frozen` |
| R13 | A stop is never the origin/destination | Trigger `stop_validate` |
| - | Name/email/ID normalised on write | Trigger `student_normalize` |
| - | Creator automatically takes seat 1 | Trigger `ride_creator_joins` |

Seeding sets `poolup.seeding = 'on'` inside its own transaction to load *historical* rides (skips only the "must be in the future" style rules; all CHECK/FK/UNIQUE still apply).

## 4. Search algorithm
Path of a ride = `origin (seq 0) -> stops (seq 1..3) -> destination (seq 99)`. A search for A -> B matches a ride if A and B both appear on the path with `seq(A) < seq(B)`. So "Main Gate -> Ameerpet" finds a Main Gate -> Airport ride that stops at Ameerpet, but "Ameerpet -> Main Gate" does not. Seats must cover the request, windows must overlap, and your own rides are excluded. Backed by the partial index `ride_open_time_idx` (only open rides).

## 5. Concurrency
`fn_create_ride` locks the creator's `student` row (`SELECT ... FOR UPDATE`) before the overlap check, so 4 simultaneous requests from one student produce exactly 1 ride (tested in `concurrent creates`).

## 6. Security
Passwords: scrypt + per-user salt. Sessions: 256-bit random token; only its SHA-256 is stored; 7-day expiry. All SQL is parameterised.
