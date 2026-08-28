import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const required = ['SEED_EMPLOYEE_PASSWORD', 'SEED_HR_PASSWORD', 'SEED_IT_PASSWORD'];
const missing = required.filter(name => !process.env[name]);
if (missing.length) {
  console.error(`Missing required development seed variables: ${missing.join(', ')}`);
  process.exitCode = 1;
} else {
  const users = [
    { email: 'demo.employee@example.test', password: process.env.SEED_EMPLOYEE_PASSWORD, name: 'Demo Employee', role: 'employee', team: 'Product' },
    { email: 'demo.hr@example.test', password: process.env.SEED_HR_PASSWORD, name: 'Demo HR Admin', role: 'hr_admin', team: 'Human Resources' },
    { email: 'demo.it@example.test', password: process.env.SEED_IT_PASSWORD, name: 'Demo IT Support', role: 'it_support', team: 'Information Technology' }
  ];
  const documents = [
    ['Employee HR Policy & Benefits Guide', 'hr', 'Human Resources', 'Internal'],
    ['Employee IT Setup & Access Guide', 'it', 'Information Technology Department', 'Internal'],
    ['Culture & Expectations Guide', 'culture', 'People Operations', 'Internal']
  ];
  try {
    for (const user of users) {
      const hash = await bcrypt.hash(user.password, 12);
      await pool.query(`INSERT INTO users(email,password_hash,full_name,role,team) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT (email) DO UPDATE SET password_hash=EXCLUDED.password_hash, full_name=EXCLUDED.full_name, role=EXCLUDED.role, team=EXCLUDED.team`, [user.email, hash, user.name, user.role, user.team]);
    }
    for (const [title, category, owner, classification] of documents) {
      await pool.query(`INSERT INTO documents(title,category,owner,classification) VALUES($1,$2,$3,$4)
        ON CONFLICT DO NOTHING`, [title, category, owner, classification]);
    }
    console.log('Development users and document metadata seeded. Upload files separately to create downloadable versions.');
  } catch (error) {
    console.error(`Seed failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
