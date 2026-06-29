// File: frontend/src/services/api.js
// Browser API client for the local role-protected relayer.

const BASE_URL = import.meta.env.VITE_RELAYER_URL || "http://localhost:4000";
const ROLE_KEY_PREFIX = "br_proxy_role_v44_";

async function request(path, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed: ${response.status}`);
  return payload;
}

export function roleToken(role) {
  return window.sessionStorage.getItem(`${ROLE_KEY_PREFIX}${role}`);
}

export function clearRoleToken(role) {
  window.sessionStorage.removeItem(`${ROLE_KEY_PREFIX}${role}`);
}

function roleHeaders(role) {
  const token = roleToken(role);
  if (!token) throw new Error("Access denied.");
  return { "x-role-token": token };
}

export async function loginRole(role, password) {
  const response = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ role, password })
  });
  window.sessionStorage.setItem(`${ROLE_KEY_PREFIX}${role}`, response.token);
  return response;
}

export const getConfig = () => request("/api/config");
export const getEligibility = (address) => request(`/api/eligibility/${address}`);
export const getResults = () => request("/api/results");

export const deployContracts = (role, payload) =>
  request("/api/admin/deploy", {
    method: "POST",
    headers: roleHeaders(role),
    body: JSON.stringify(payload)
  });

export const importRegister = (role, csvText) =>
  request("/api/transfer-agent/import-register", {
    method: "POST",
    headers: roleHeaders(role),
    body: JSON.stringify({ csvText })
  });

export const getRegister = (role) =>
  request("/api/transfer-agent/register", {
    headers: roleHeaders(role)
  });

export const finalizeRecordDate = (role) =>
  request("/api/admin/finalize-record-date", {
    method: "POST",
    headers: roleHeaders(role),
    body: JSON.stringify({})
  });

export const createSnapshot = finalizeRecordDate;

export const endVotingNow = (role) =>
  request("/api/admin/end-now", {
    method: "POST",
    headers: roleHeaders(role),
    body: JSON.stringify({})
  });

export const buildBallot = (voter, choices) =>
  request("/api/build-ballot", {
    method: "POST",
    body: JSON.stringify({ voter, choices })
  });

export const relayVote = (voter, choices, message, signature) =>
  request("/api/relay-vote", {
    method: "POST",
    body: JSON.stringify({ voter, choices, message, signature })
  });

export const buildDelegation = (delegator, delegatee) =>
  request("/api/build-delegation", {
    method: "POST",
    body: JSON.stringify({ delegator, delegatee })
  });

export const relayDelegation = (delegator, delegatee, message, signature) =>
  request("/api/relay-delegation", {
    method: "POST",
    body: JSON.stringify({ delegator, delegatee, message, signature })
  });

export const getAudit = (role) =>
  request("/api/inspector/audit", {
    headers: roleHeaders(role)
  });

export const getParticipation = (role) =>
  request("/api/solicitor/participation", {
    headers: roleHeaders(role)
  });

export const exportState = (role) =>
  request("/api/export-state", {
    headers: roleHeaders(role)
  });
