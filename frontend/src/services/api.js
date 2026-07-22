// File: frontend/src/services/api.js
// Browser API client for the role-protected, multi-event relayer.

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
  if (!response.ok) {
    const error = new Error(payload.error || `Request failed: ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function eventPath(eventId, scopedPath, legacyPath) {
  if (!eventId) return legacyPath;
  return `/api/events/${encodeURIComponent(eventId)}${scopedPath}`;
}

async function eventRequest(eventId, scopedPath, legacyPath, options = {}) {
  if (!eventId) return request(legacyPath, options);

  try {
    return await request(eventPath(eventId, scopedPath, legacyPath), options);
  } catch (error) {
    // Allows a zero-downtime rollout when Vercel updates before Render.
    if (error.status !== 404) throw error;
    return request(legacyPath, options);
  }
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

function fallbackEventFromConfig(config) {
  if (!config?.deployed || !config?.contracts?.voting) return null;
  const current = Math.floor(Date.now() / 1000);
  const start = Number(config.voting?.startTimestamp || 0);
  const end = Number(config.voting?.endTimestamp || 0);
  const status = config.voting?.resultsAvailable || (end > 0 && current >= end)
    ? "closed"
    : start > 0 && current < start
      ? "pending"
      : "open";

  return {
    ...config,
    eventId: config.eventId || config.contracts.voting,
    status,
    ongoing: status !== "closed"
  };
}

function fallbackEligibilityIsRelevant(eligibility) {
  return Boolean(
    eligibility?.relevant ||
      eligibility?.eligible ||
      eligibility?.exists ||
      eligibility?.blacklisted ||
      eligibility?.hasTokenEntitlement ||
      eligibility?.hasSnapshotVotingPower ||
      eligibility?.hasVoted ||
      eligibility?.hasDelegated ||
      Number(eligibility?.delegatedPower || 0) > 0 ||
      Number(eligibility?.effectiveVotingPower || 0) > 0
  );
}

export async function getEvents() {
  try {
    return await request("/api/events");
  } catch (error) {
    if (error.status !== 404) throw error;
    const fallback = fallbackEventFromConfig(await request("/api/config"));
    return { events: fallback ? [fallback] : [], count: fallback ? 1 : 0, legacyFallback: true };
  }
}

export async function getWalletEvents(address) {
  try {
    return await request(`/api/wallets/${encodeURIComponent(address)}/events`);
  } catch (error) {
    if (error.status !== 404) throw error;
    const [config, eligibility] = await Promise.all([
      request("/api/config"),
      request(`/api/eligibility/${encodeURIComponent(address)}`)
    ]);
    const fallback = fallbackEventFromConfig(config);
    const events = fallback && fallbackEligibilityIsRelevant(eligibility)
      ? [{ ...fallback, eligibility: { ...eligibility, eventId: fallback.eventId } }]
      : [];
    return {
      address,
      events,
      eligibleEventCount: events.filter((item) => item.eligibility?.eligible).length,
      openEventCount: events.filter((item) => item.status === "open").length,
      legacyFallback: true
    };
  }
}

export const getConfig = (eventId = null) =>
  eventRequest(eventId, "/config", "/api/config");

export const getEligibility = (address, eventId = null) =>
  eventRequest(
    eventId,
    `/eligibility/${encodeURIComponent(address)}`,
    `/api/eligibility/${encodeURIComponent(address)}`
  );

export const getResults = (eventId = null) =>
  eventRequest(eventId, "/results", "/api/results");

export const deployContracts = (role, payload) =>
  request("/api/admin/deploy", {
    method: "POST",
    headers: roleHeaders(role),
    body: JSON.stringify(payload)
  });

export const importRegister = (role, csvText, eventId = null) =>
  eventRequest(
    eventId,
    "/transfer-agent/import-register",
    "/api/transfer-agent/import-register",
    {
      method: "POST",
      headers: roleHeaders(role),
      body: JSON.stringify({ csvText })
    }
  );

export const getRegister = (role, eventId = null) =>
  eventRequest(
    eventId,
    "/transfer-agent/register",
    "/api/transfer-agent/register",
    { headers: roleHeaders(role) }
  );

export const finalizeRecordDate = (role, eventId = null) =>
  eventRequest(
    eventId,
    "/admin/finalize-record-date",
    "/api/admin/finalize-record-date",
    {
      method: "POST",
      headers: roleHeaders(role),
      body: JSON.stringify({})
    }
  );

export const createSnapshot = finalizeRecordDate;

export const endVotingNow = (role, eventId = null) =>
  eventRequest(eventId, "/admin/end-now", "/api/admin/end-now", {
    method: "POST",
    headers: roleHeaders(role),
    body: JSON.stringify({})
  });

export const buildBallot = (voter, choices, eventId = null) =>
  eventRequest(eventId, "/build-ballot", "/api/build-ballot", {
    method: "POST",
    body: JSON.stringify({ voter, choices })
  });

export const relayVote = (voter, choices, message, signature, eventId = null) =>
  eventRequest(eventId, "/relay-vote", "/api/relay-vote", {
    method: "POST",
    body: JSON.stringify({ voter, choices, message, signature })
  });

export const buildDelegation = (delegator, delegatee, eventId = null) =>
  eventRequest(eventId, "/build-delegation", "/api/build-delegation", {
    method: "POST",
    body: JSON.stringify({ delegator, delegatee })
  });

export const relayDelegation = (
  delegator,
  delegatee,
  message,
  signature,
  eventId = null
) =>
  eventRequest(eventId, "/relay-delegation", "/api/relay-delegation", {
    method: "POST",
    body: JSON.stringify({ delegator, delegatee, message, signature })
  });

export const getAudit = (role, eventId = null) =>
  eventRequest(eventId, "/inspector/audit", "/api/inspector/audit", {
    headers: roleHeaders(role)
  });

export const getParticipation = (role, eventId = null) =>
  eventRequest(
    eventId,
    "/solicitor/participation",
    "/api/solicitor/participation",
    { headers: roleHeaders(role) }
  );

export const exportState = (role, eventId = null) =>
  eventRequest(eventId, "/export-state", "/api/export-state", {
    headers: roleHeaders(role)
  });
