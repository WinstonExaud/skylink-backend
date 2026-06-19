/**
 * SKYLINK NET — Seed Script
 * Run: node src/config/seed.js
 *
 * Creates default admin account and data plans.
 */

require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool   = require('./db');

async function seed() {
  const client = await pool.connect();
  try {
    console.log('🌱  Seeding database...');

    // ── Default admin ──────────────────────────────────
    const username = process.env.ADMIN_USERNAME || 'admin';
    const password = process.env.ADMIN_PASSWORD || 'admin123';
    const hash     = await bcrypt.hash(password, 12);

    await client.query(`
      INSERT INTO admins (username, password, role)
      VALUES ($1, $2, 'super_admin')
      ON CONFLICT (username) DO NOTHING
    `, [username, hash]);

    console.log(`✅  Admin created: ${username} / ${password}`);

    // ── Default plans ──────────────────────────────────
    const plans = [
      { name: 'Hourly',  duration_minutes: 60,    price: 500,   speed: '5 Mbps'    },
      { name: 'Daily',   duration_minutes: 1440,  price: 1000,  speed: '10 Mbps'   },
      { name: 'Weekly',  duration_minutes: 10080, price: 7000,  speed: '10 Mbps'   },
      { name: 'Monthly', duration_minutes: 43200, price: 25000, speed: 'Unlimited' },
    ];

    for (const p of plans) {
      await client.query(`
        INSERT INTO plans (name, duration_minutes, price, speed_limit)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT DO NOTHING
      `, [p.name, p.duration_minutes, p.price, p.speed]);
    }

    console.log('✅  Plans seeded: Hourly, Daily, Weekly, Monthly');
    console.log('🎉  Seed complete.');

  } catch (err) {
    console.error('❌  Seed failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
