// Database setup. Uses PostgreSQL when DATABASE_URL is a postgres:// URL (AWS RDS),
// otherwise a local SQLite file (handy for development and tests).
const path = require('path');
const knexLib = require('knex');

const url = process.env.DATABASE_URL || '';
const isPg = /^postgres(ql)?:\/\//.test(url);

if (isPg) {
  // Return BIGINT columns (epoch-ms timestamps, totals) as JS numbers instead of strings.
  const pgTypes = require('pg').types;
  pgTypes.setTypeParser(20, (v) => (v === null ? null : Number(v)));
}

const sslOn = isPg && process.env.DATABASE_SSL !== 'false';

const knex = knexLib(
  isPg
    ? {
        client: 'pg',
        connection: { connectionString: url, ssl: sslOn ? { rejectUnauthorized: false } : false },
        pool: { min: 0, max: 10 },
      }
    : {
        client: 'better-sqlite3',
        connection: { filename: url.replace(/^sqlite:/, '') || path.join(__dirname, '..', 'data.sqlite') },
        useNullAsDefault: true,
        pool: {
          afterCreate: (conn, done) => {
            conn.pragma('foreign_keys = ON');
            conn.pragma('journal_mode = WAL');
            done();
          },
        },
      }
);

// Versioned migrations kept in code so the Docker image is self-contained.
// All timestamps are epoch milliseconds (BIGINT); all money is integer cents.
const migrations = {
  '001_initial': {
    async up(k) {
      await k.schema.createTable('organizations', (t) => {
        t.increments('id');
        t.string('name', 120).notNullable();
        t.string('timezone', 64).notNullable().defaultTo('America/New_York');
        t.string('currency', 3).notNullable().defaultTo('USD');
        t.bigInteger('created_at').notNullable();
      });
      await k.schema.createTable('users', (t) => {
        t.increments('id');
        t.string('name', 120);
        t.string('email', 254).unique();
        t.string('phone', 20).unique();
        t.string('google_sub', 64).unique();
        t.string('facebook_id', 64).unique();
        t.bigInteger('created_at').notNullable();
      });
      await k.schema.createTable('members', (t) => {
        t.increments('id');
        t.integer('org_id').notNullable().references('organizations.id').onDelete('CASCADE');
        t.integer('user_id').references('users.id').onDelete('SET NULL');
        t.string('display_name', 120).notNullable();
        t.string('invite_email', 254);
        t.string('invite_phone', 20);
        t.string('role', 16).notNullable().defaultTo('employee'); // owner | admin | employee
        t.integer('hourly_rate_cents').notNullable().defaultTo(0);
        t.boolean('active').notNullable().defaultTo(true);
        t.bigInteger('created_at').notNullable();
        t.unique(['org_id', 'user_id']);
        t.index(['invite_email']);
        t.index(['invite_phone']);
      });
      await k.schema.createTable('shifts', (t) => {
        t.increments('id');
        t.integer('org_id').notNullable().references('organizations.id').onDelete('CASCADE');
        t.integer('member_id').notNullable().references('members.id').onDelete('CASCADE');
        t.bigInteger('clock_in').notNullable();
        t.bigInteger('clock_out');
        t.integer('rate_cents').notNullable(); // rate locked in when the shift started
        t.string('note', 500);
        t.integer('edited_by').references('users.id').onDelete('SET NULL');
        t.bigInteger('created_at').notNullable();
        t.index(['member_id', 'clock_in']);
        t.index(['org_id', 'clock_in']);
      });
      // At most one open shift per member, enforced by the database (works in Postgres and SQLite).
      await k.raw('CREATE UNIQUE INDEX shifts_one_open_per_member ON shifts (member_id) WHERE clock_out IS NULL');
      await k.schema.createTable('payments', (t) => {
        t.increments('id');
        t.integer('org_id').notNullable().references('organizations.id').onDelete('CASCADE');
        t.integer('member_id').notNullable().references('members.id').onDelete('CASCADE');
        t.integer('amount_cents').notNullable();
        t.string('method', 20).notNullable().defaultTo('cash');
        t.bigInteger('paid_at').notNullable();
        t.string('note', 500);
        t.integer('recorded_by').references('users.id').onDelete('SET NULL');
        t.bigInteger('created_at').notNullable();
        t.index(['member_id', 'paid_at']);
      });
      await k.schema.createTable('otp_codes', (t) => {
        t.increments('id');
        t.string('target', 254).notNullable();
        t.string('code_hash', 64).notNullable();
        t.integer('attempts').notNullable().defaultTo(0);
        t.bigInteger('expires_at').notNullable();
        t.bigInteger('created_at').notNullable();
        t.index(['target']);
      });
    },
    async down(k) {
      for (const t of ['otp_codes', 'payments', 'shifts', 'members', 'users', 'organizations']) {
        await k.schema.dropTableIfExists(t);
      }
    },
  },
};

const migrationSource = {
  getMigrations: async () => Object.keys(migrations).sort(),
  getMigrationName: (m) => m,
  getMigration: async (m) => migrations[m],
};

async function migrate() {
  await knex.migrate.latest({ migrationSource });
}

module.exports = { knex, migrate, isPg };
