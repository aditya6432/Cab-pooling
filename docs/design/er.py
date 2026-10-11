#!/usr/bin/env python3
"""Generates the full PoolUp ER diagram (Graphviz) -> docs/design/er-diagram.svg / .png
Run:  python3 docs/design/er.py      (needs the `dot` binary from Graphviz)
Crow's-foot notation: a bar (|) is "exactly one", a crow's foot is "many",
a circle is "optional". Entity headers are coloured by the member who owns the table.
"""
import pathlib
import subprocess

HERE = pathlib.Path(__file__).resolve().parent
MOD = {
    'M1': ('#2a78d6', 'Member 1 · Users + ride creation / search'),
    'M2': ('#b45309', 'Member 2 · Booking + ride pooling / seats'),
    'M3': ('#0f766e', 'Member 3 · Expense splitting'),
    'M4': ('#6d28d9', 'Member 4 · Payments + settlement'),
    'M5': ('#be123c', 'Member 5 · Ratings + analytics'),
}

# name, module, note, rows of (key-kind, attributes)
E = [
    ('HOSTEL', 'M1', '', [('PK', 'hostel_id'), ('UQ', 'name')]),
    ('STUDENT', 'M1', '', [('PK', 'student_id  (BITS ID pattern)'), ('UQ', 'email  (@hyderabad.bits-pilani.ac.in)'), ('UQ', 'phone  (10 digits)'),
                           ('FK', 'hostel_id'), ('', 'full_name, password_hash, created_at')]),
    ('AUTH_SESSION', 'M1', '', [('PK', 'token_hash  (SHA-256)'), ('FK', 'student_id'), ('', 'created_at, expires_at')]),
    ('LOCATION', 'M1', '', [('PK', 'location_id'), ('UQ', 'name'), ('', 'loc_type, latitude, longitude')]),
    ('CAB_TYPE', 'M1', '', [('PK', 'cab_type'), ('', 'max_seats, base_fare, per_km')]),
    ('RIDE', 'M1', '', [('PK', 'ride_id'), ('FK', 'creator_id → STUDENT'), ('FK', 'origin_id, dest_id → LOCATION'), ('FK', 'cab_type'),
                        ('', 'depart_start, depart_end  (≤ 3 h)'), ('', 'distance_km, note'), ('', 'status, completed_at')]),
    ('RIDE_STOP', 'M1', 'weak', [('PK,FK', 'ride_id'), ('PK', 'stop_seq  (1..3)'), ('FK', 'location_id'), ('UQ', '(ride_id, location_id)')]),
    ('RIDE_STATUS_LOG', 'M1', 'history', [('PK', 'log_id'), ('FK', 'ride_id'), ('', 'old_status, new_status, changed_at')]),

    ('RIDE_MEMBER', 'M2', 'seat booking · hub of the schema', [('PK,FK', 'ride_id'), ('PK,FK', 'student_id'), ('', 'seats_taken  (1..6)'),
                        ('', 'status: confirmed | cancelled | no_show'), ('FK', 'pickup_id, dropoff_id → LOCATION'), ('', 'joined_at, cancelled_at, cancel_reason')]),
    ('RIDE_BOOKING_POLICY', 'M2', '', [('PK,FK', 'ride_id  (1 : 0..1)'), ('', 'join_mode: instant | approval')]),
    ('BOOKING_REQUEST', 'M2', '', [('PK', 'request_id'), ('FK', 'ride_id, student_id'), ('FK', 'pickup_id, dropoff_id'), ('', 'seats, message, status'),
                        ('UQ', '(ride_id, student_id) WHERE pending')]),
    ('RIDE_WAITLIST', 'M2', '', [('PK,FK', 'ride_id'), ('PK,FK', 'student_id'), ('', 'seats, joined_at  (FIFO order)')]),
    ('BOOKING_EVENT', 'M2', 'history', [('PK', 'event_id'), ('FK', 'ride_id, student_id'), ('', 'event (13 kinds), seats, created_at')]),

    ('EXPENSE', 'M3', '', [('PK', 'expense_id'), ('FK', '(ride_id, paid_by) → RIDE_MEMBER'), ('', 'amount  (0 < a ≤ 50 000)'), ('', 'note, split_type, created_at')]),
    ('EXPENSE_SHARE', 'M3', 'weak', [('PK,FK', 'expense_id'), ('PK,FK', 'student_id'), ('', 'share_amount  (Σ = amount, deferred)')]),
    ('EXPENSE_AUDIT', 'M3', 'history', [('PK', 'audit_id'), ('', 'expense_id, ride_id  (no FK: outlives deletes)'), ('', 'action, actor_id, amount')]),

    ('PAYMENT_METHOD', 'M4', '', [('PK', 'method_id'), ('FK', 'student_id'), ('UQ', 'vpa  (name@bank)'), ('UQ', 'is_default: one per student (partial)')]),
    ('PAYMENT_TRANSITION', 'M4', 'state machine as data', [('PK', '(from_status, to_status, actor_role)'), ('', 'meaning')]),
    ('PAYMENT', 'M4', '', [('PK', 'payment_id'), ('UQ', 'client_ref  (idempotency key)'), ('UQ', 'utr  (12 digits, UPI only)'),
                           ('FK', '(ride_id, payer_id) → RIDE_MEMBER'), ('FK', '(ride_id, payee_id) → RIDE_MEMBER'),
                           ('', 'amount, method: upi | cash | offset'), ('', 'status, offset_group, confirmed_at')]),
    ('PAYMENT_EVENT', 'M4', 'history', [('PK', 'event_id'), ('FK', 'payment_id'), ('FK', 'actor_id'), ('', 'from_status, to_status, actor_role')]),
    ('PAYMENT_REMINDER', 'M4', '', [('PK', 'reminder_id'), ('FK', '(ride_id, creditor_id) → RIDE_MEMBER'), ('FK', '(ride_id, debtor_id) → RIDE_MEMBER'),
                           ('EX', 'no overlapping 24 h windows (GiST)'), ('', 'amount_due, message, sent_at')]),

    ('RATING', 'M5', '', [('PK', '(ride_id, rater_id, ratee_id)'), ('FK', '(ride_id, rater_id) → RIDE_MEMBER'), ('FK', '(ride_id, ratee_id) → RIDE_MEMBER'),
                          ('', 'score  (1..5), comment'), ('', 'created_at, updated_at')]),
    ('RATING_TAG', 'M5', '', [('PK', 'tag_id'), ('UQ', 'label'), ('', 'sentiment')]),
    ('RATING_TAG_MAP', 'M5', '', [('PK,FK', '(ride_id, rater_id, ratee_id)'), ('PK,FK', 'tag_id')]),
    ('RATING_AUDIT', 'M5', 'history', [('PK', 'audit_id'), ('', 'ride_id, rater_id, ratee_id'), ('', 'action, old/new score, changed_at')]),
]

ONE, MANY, ZERO_ONE, ZERO_MANY = 'tee', 'crow', 'teeodot', 'crowodot'
# parent, child, parent-end, child-end, label, style
R = [
    ('HOSTEL', 'STUDENT', ONE, ZERO_MANY, 'lives in', ''),
    ('STUDENT', 'AUTH_SESSION', ONE, ZERO_MANY, '', ''),
    ('STUDENT', 'RIDE', ONE, ZERO_MANY, 'creates', ''),
    ('LOCATION', 'RIDE', ONE, ZERO_MANY, 'origin / destination', ''),
    ('CAB_TYPE', 'RIDE', ONE, ZERO_MANY, '', ''),
    ('RIDE', 'RIDE_STOP', ONE, ZERO_MANY, 'stops (≤ 3)', 'bold'),
    ('LOCATION', 'RIDE_STOP', ONE, ZERO_MANY, '', ''),
    ('RIDE', 'RIDE_STATUS_LOG', ONE, ZERO_MANY, '', 'dashed'),
    ('RIDE', 'RIDE_MEMBER', ONE, MANY, 'has seats', ''),
    ('STUDENT', 'RIDE_MEMBER', ONE, ZERO_MANY, 'books', ''),
    ('RIDE', 'RIDE_BOOKING_POLICY', ONE, ZERO_ONE, '', ''),
    ('RIDE', 'BOOKING_REQUEST', ONE, ZERO_MANY, '', ''),
    ('STUDENT', 'BOOKING_REQUEST', ONE, ZERO_MANY, '', ''),
    ('RIDE', 'RIDE_WAITLIST', ONE, ZERO_MANY, '', ''),
    ('STUDENT', 'RIDE_WAITLIST', ONE, ZERO_MANY, '', ''),
    ('RIDE', 'BOOKING_EVENT', ONE, ZERO_MANY, '', 'dashed'),
    ('RIDE_MEMBER', 'EXPENSE', ONE, ZERO_MANY, 'pays', ''),
    ('EXPENSE', 'EXPENSE_SHARE', ONE, MANY, 'split into', 'bold'),
    ('STUDENT', 'EXPENSE_SHARE', ONE, ZERO_MANY, '', ''),
    ('EXPENSE', 'EXPENSE_AUDIT', ONE, ZERO_MANY, '', 'dotted'),
    ('STUDENT', 'PAYMENT_METHOD', ONE, ZERO_MANY, '', ''),
    ('RIDE_MEMBER', 'PAYMENT', ONE, ZERO_MANY, 'pays / is paid', ''),
    ('PAYMENT', 'PAYMENT_EVENT', ONE, MANY, '', 'dashed'),
    ('PAYMENT_TRANSITION', 'PAYMENT_EVENT', ONE, ZERO_MANY, 'allowed moves', 'dotted'),
    ('RIDE_MEMBER', 'PAYMENT_REMINDER', ONE, ZERO_MANY, 'reminds', ''),
    ('RIDE_MEMBER', 'RATING', ONE, ZERO_MANY, 'rates / is rated', ''),
    ('RATING', 'RATING_TAG_MAP', ONE, ZERO_MANY, '≤ 3 tags', ''),
    ('RATING_TAG', 'RATING_TAG_MAP', ONE, ZERO_MANY, '', ''),
    ('RATING', 'RATING_AUDIT', ONE, MANY, '', 'dotted'),
]


def node(name, mod, note, rows):
    color = MOD[mod][0]
    head = f'<b>{name}</b>' + (f'  <font point-size="8">({note})</font>' if note else '')
    body = ''.join(
        f'<tr><td align="left" width="38">' + (f'<font point-size="8" color="{color}"><b>{k}</b></font>' if k else ' ') + '</td>'
        f'<td align="left">{a.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")}</td></tr>'
        for k, a in rows)
    return (f'  {name} [label=<<table border="1" cellborder="0" cellspacing="0" cellpadding="3" color="{color}" bgcolor="white">'
            f'<tr><td colspan="2" bgcolor="{color}" align="left"><font color="white">{head}</font></td></tr>{body}</table>>];')


def main():
    out = ['digraph PoolUp {',
           '  graph [rankdir=LR, splines=spline, nodesep=0.28, ranksep=0.75, fontname="DejaVu Sans", bgcolor="white", pad=0.25];',
           '  node  [shape=plain, fontname="DejaVu Sans", fontsize=9];',
           '  edge  [fontname="DejaVu Sans", fontsize=8, color="#4b5563", fontcolor="#374151", arrowsize=0.75, penwidth=1.1, dir=both];']
    for mod, (color, label) in MOD.items():
        out.append(f'  subgraph cluster_{mod} {{ label=<<b>{label}</b>>; fontsize=11; fontcolor="{color}"; color="{color}"; style="rounded,dashed"; margin=10;')
        out += [node(*e) for e in E if e[1] == mod]
        out.append('  }')
    for p, c, pe, ce, label, style in R:
        attrs = [f'arrowtail={pe}', f'arrowhead={ce}']
        if label:
            attrs.append(f'label=" {label} "')
        if style:
            attrs.append(f'style={style}')
        out.append(f'  {p} -> {c} [{", ".join(attrs)}];')
    out.append('}')
    dot = '\n'.join(out)
    (HERE / 'er-diagram.dot').write_text(dot)
    for fmt in ('svg', 'png'):
        args = ['dot', f'-T{fmt}', str(HERE / 'er-diagram.dot'), '-o', str(HERE / f'er-diagram.{fmt}')]
        if fmt == 'png':
            args.insert(1, '-Gdpi=170')
        subprocess.run(args, check=True)
    print('wrote', HERE / 'er-diagram.svg', HERE / 'er-diagram.png')


if __name__ == '__main__':
    main()
