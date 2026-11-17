import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual
} from 'node:crypto';
import { promisify } from 'node:util';
import {
  createAccount,
  createSession,
  findUserByEmail,
  getSessionUser,
  listUserBusinesses,
  revokeSession
} from './repository.js';

const scryptAsync = promisify(scrypt);
const SCRYPT_COST = 16384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELISM = 1;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DUMMY_PASSWORD_HASH =
  'scrypt$16384$8$1$00000000000000000000000000000000$' + '0'.repeat(128);

async function derivePasswordKey(password, salt, keyLength) {
  return Buffer.from(await scryptAsync(password, salt, keyLength, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLELISM,
    maxmem: 64 * 1024 * 1024
  }));
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await derivePasswordKey(password, salt, 64);
  return [
    'scrypt',
    SCRYPT_COST,
    SCRYPT_BLOCK_SIZE,
    SCRYPT_PARALLELISM,
    salt.toString('hex'),
    key.toString('hex')
  ].join('$');
}

export async function verifyPassword(password, encodedHash) {
  if (typeof encodedHash !== 'string') return false;
  const parts = encodedHash.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const cost = Number(parts[1]);
  const blockSize = Number(parts[2]);
  const parallelism = Number(parts[3]);
  const saltHex = parts[4];
  const keyHex = parts[5];

  if (
    cost !== SCRYPT_COST ||
    blockSize !== SCRYPT_BLOCK_SIZE ||
    parallelism !== SCRYPT_PARALLELISM ||
    !/^[0-9a-f]{32}$/i.test(saltHex) ||
    !/^[0-9a-f]{128}$/i.test(keyHex)
  ) {
    return false;
  }

  const expected = Buffer.from(keyHex, 'hex');
  const actual = await derivePasswordKey(password, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(expected, actual);
}

function hashSessionToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function createSessionMaterial(userId) {
  const accessToken = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  return {
    accessToken,
    session: {
      id: randomUUID(),
      userId,
      tokenHash: hashSessionToken(accessToken),
      expiresAt: expiresAt.toISOString()
    },
    expiresAt: expiresAt.toISOString()
  };
}

function authPayload(accessToken, expiresAt, user, businesses) {
  return {
    accessToken,
    tokenType: 'Bearer',
    expiresAt,
    user,
    businesses
  };
}

export async function registerAccount({
  email,
  password,
  fullName,
  accountType,
  businessName,
  countryCode
}) {
  const user = {
    id: randomUUID(),
    email,
    fullName,
    accountType,
    passwordHash: await hashPassword(password),
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const business = accountType === 'business'
    ? {
        id: randomUUID(),
        name: businessName,
        countryCode: countryCode || null
      }
    : null;

  const material = createSessionMaterial(user.id);
  const account = await createAccount({
    user,
    business,
    session: material.session
  });

  return authPayload(
    material.accessToken,
    material.expiresAt,
    account.user,
    account.businesses
  );
}

export async function loginAccount(email, password) {
  const user = await findUserByEmail(email);
  const passwordValid = await verifyPassword(
    password,
    user?.passwordHash || DUMMY_PASSWORD_HASH
  );

  if (!user || user.status !== 'active' || !passwordValid) return null;

  const material = createSessionMaterial(user.id);
  await createSession(material.session);
  const businesses = await listUserBusinesses(user.id);

  return authPayload(
    material.accessToken,
    material.expiresAt,
    {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      accountType: user.accountType,
      status: user.status,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt
    },
    businesses
  );
}

export async function authenticateAccessToken(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const tokenHash = hashSessionToken(token);
  const user = await getSessionUser(tokenHash);
  return user ? { tokenHash, user } : null;
}

export async function logoutAccessToken(tokenHash) {
  return revokeSession(tokenHash);
}

export async function getAccountProfile(user) {
  return {
    user,
    businesses: await listUserBusinesses(user.id)
  };
}
