/**
 * Leave Sync for YouTrack – storage helpers (utility module).
 *
 * App global storage (AppGlobalStorage):
 *   leaveConfig    JSON: calendar, reasons, tiers, user mapping, sync state
 *   leaveAudit     JSON array: last admin changes
 * Per user (User extension properties):
 *   leaveEnabled   boolean: user is tracked
 *   leaveProfile   JSON: hire date, birth date, opening balance, overrides, adjustments
 *   leaveRecords   JSON array: leave items synced from Teams Shifts
 */
const entities = require('@jetbrains/youtrack-scripting-api/entities');
const engine = require('./engine');

const AUDIT_LIMIT = 300;

function parse(raw, fallback) {
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch (e) { return fallback; }
}

function getConfig(ctx) {
  return engine.mergeConfig(parse(ctx.globalStorage.extensionProperties.leaveConfig, null));
}

function saveConfig(ctx, cfg) {
  ctx.globalStorage.extensionProperties.leaveConfig = JSON.stringify(cfg);
}

function getProfile(user) {
  return parse(user.extensionProperties.leaveProfile, {});
}

function saveProfile(user, profile) {
  user.extensionProperties.leaveProfile = JSON.stringify(profile);
}

function getRecords(user) {
  return parse(user.extensionProperties.leaveRecords, []);
}

function saveRecords(user, records) {
  user.extensionProperties.leaveRecords = JSON.stringify(records);
}

function isEnabled(user) {
  return user.extensionProperties.leaveEnabled === true;
}

function setEnabled(user, value) {
  user.extensionProperties.leaveEnabled = !!value;
}

/** All tracked employees. */
function listEmployees() {
  const out = [];
  const set = entities.User.findByExtensionProperties({ leaveEnabled: true });
  if (set) set.forEach(function (u) { out.push(u); });
  return out;
}

function findUser(login) {
  if (!login) return null;
  return entities.User.findByLogin(String(login));
}

function audit(ctx, action, target, details) {
  const list = parse(ctx.globalStorage.extensionProperties.leaveAudit, []);
  list.unshift({
    at: new Date().toISOString(),
    by: ctx.currentUser.login,
    byName: ctx.currentUser.visibleName,
    action: action,
    target: target || null,
    details: details || null
  });
  ctx.globalStorage.extensionProperties.leaveAudit = JSON.stringify(list.slice(0, AUDIT_LIMIT));
}

function getAudit(ctx) {
  return parse(ctx.globalStorage.extensionProperties.leaveAudit, []);
}

module.exports = {
  getConfig: getConfig,
  saveConfig: saveConfig,
  getProfile: getProfile,
  saveProfile: saveProfile,
  getRecords: getRecords,
  saveRecords: saveRecords,
  isEnabled: isEnabled,
  setEnabled: setEnabled,
  listEmployees: listEmployees,
  findUser: findUser,
  audit: audit,
  getAudit: getAudit
};
