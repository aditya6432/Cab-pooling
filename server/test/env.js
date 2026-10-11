// Imported FIRST by every test (through helpers.js): point the app at an isolated
// database "poolup_test", so running the tests never touches the demo database.
const base = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/poolup';
const url = new URL(base);
url.pathname = '/poolup_test';
process.env.DATABASE_URL = url.toString();
