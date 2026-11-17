import './config.js';
import { grantPlatformAdminByEmail, closeDatabase } from './repository.js';

if (!process.env.DATABASE_URL?.trim()) {
  throw new Error('DATABASE_URL is required to grant a persistent platform administrator.');
}

const email = process.argv[2]?.trim().toLowerCase();
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 254) {
  throw new Error('Usage: npm run platform-admin:add -- user@example.com');
}

try {
  const admin = await grantPlatformAdminByEmail(email);
  if (!admin) throw new Error('No existing SwiftServe account was found for that email.');
  console.info(JSON.stringify({
    event: 'platform_admin_granted',
    userId: admin.userId
  }));
} finally {
  await closeDatabase();
}
