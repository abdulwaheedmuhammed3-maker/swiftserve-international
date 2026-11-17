import { AsyncLocalStorage } from 'node:async_hooks';

const adminContext = new AsyncLocalStorage();

export function runWithAdminContext(admin, callback) {
  return adminContext.run(admin, callback);
}

export function getCurrentAdmin() {
  return adminContext.getStore() || null;
}
