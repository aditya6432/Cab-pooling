-- =====================================================================
-- PoolUp — RATING TAG VOCABULARY  (16_m5_rating_tags.sql)
-- Owner: Member 5. Reference data (not demo data) — required for the
-- module to work, so it ships with the schema rather than the seed.
-- =====================================================================
INSERT INTO rating_tag (label, sentiment) VALUES
    ('Punctual',              'positive'),
    ('Friendly',              'positive'),
    ('Paid on time',          'positive'),
    ('Clear communication',   'positive'),
    ('Respectful',            'positive'),
    ('Helped with luggage',   'positive'),
    ('Good conversation',     'positive'),
    ('Late',                  'negative'),
    ('Payment delayed',       'negative'),
    ('Poor communication',    'negative'),
    ('Rude',                  'negative'),
    ('Too much luggage',      'negative'),
    ('Last-minute changes',   'negative');
