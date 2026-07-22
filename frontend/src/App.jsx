// File: frontend/src/App.jsx
// Production-style Broadridge proxy-voting portal using the preserved workspace theme.

import { useCallback, useEffect, useRef, useState } from "react";
import { NavLink, Route, Routes, useNavigate } from "react-router-dom";
import { useAppKit, useAppKitAccount, useAppKitProvider, useDisconnect } from "@reown/appkit/react";
import {
  buildBallot,
  buildDelegation,
  clearRoleToken,
  createSnapshot,
  deployContracts,
  endVotingNow,
  exportState,
  getAudit,
  getConfig,
  getEligibility,
  getEvents,
  getParticipation,
  getResults,
  getWalletEvents,
  importRegister,
  loginRole,
  relayDelegation,
  relayVote
} from "./services/api.js";
import {
  activeWalletAccount,
  ensureHardhatNetwork,
  shortAddress,
  signTypedBallot,
  watchAsset
} from "./services/wallet.js";

const EMPTY_PROPOSAL = { question: "", options: ["For", "Against", "Abstain"] };
const SELECTED_EVENT_KEY = "br_proxy_selected_event_v50";
const ROLE_META = {
  issuer: ["Issuer", "/issuer"],
  transferAgent: ["Transfer Agent", "/transfer-agent"],
  inspector: ["Inspector of Elections", "/inspector"],
  solicitor: ["Proxy Solicitor", "/proxy-solicitor"],
  admin: ["Admin", "/admin"]
};

const WELCOME_HEADLINES = [
  "Welcome to Broadridge Proxy Voting",
  "Your record-date voting rights, on-chain",
  "Cast one secure gasless ballot"
];

const DEFAULT_REGISTER_CSV = `Wallet,Shares,Label,BeneficialOwner,Custodian
0x70997970C51812dc3A010C7d01b50e0d17dc79C8,40,Holder 1,Investor Alpha,Demo Custodian A
0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC,25,Holder 2,Investor Beta,Demo Custodian A
0x90F79bf6EB2c4f870365E785982E1f101E93b906,15,Holder 3,Investor Gamma,Demo Custodian B
0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65,12,Holder 4,Investor Delta,Demo Custodian B
0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc,8,Holder 5,Investor Epsilon,Demo Custodian C`;


function unixFromInput(value) {
  if (!value) return "";
  return Math.floor(new Date(value).getTime() / 1000);
}

function inputFromUnix(value) {
  if (!value) return "";
  const date = new Date(Number(value) * 1000);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function timeLabel(timestamp) {
  if (!timestamp) return "—";
  return new Date(Number(timestamp) * 1000).toLocaleString();
}

function numberLabel(value) {
  return Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function tokenLabel(value, symbol = "") {
  return `${numberLabel(value)}${symbol ? ` ${symbol}` : ""}`;
}

function percent(value) {
  return `${Number(value || 0).toFixed(1)}%`;
}

function truncate(value, max = 42) {
  const text = String(value || "");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function tokenPromptKey(account, eligibility) {
  if (!account || !eligibility?.tokenAddress) return null;
  return `br_proxy_token_prompt_v44_${account.toLowerCase()}_${eligibility.tokenAddress.toLowerCase()}`;
}

function StatusPill({ children, tone = "neutral" }) {
  return (
    <span className={`status-pill ${tone}`}>
      <span className={`status-dot ${tone}`} aria-hidden="true" />
      {children}
    </span>
  );
}

function DataRow({ label, value }) {
  return (
    <div className="data-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function eventTone(status) {
  if (status === "open") return "success";
  if (status === "pending") return "info";
  if (status === "unavailable") return "danger";
  return "neutral";
}

function eventStatusLabel(status) {
  if (status === "open") return "Open";
  if (status === "pending") return "Upcoming";
  if (status === "closed") return "Closed";
  if (status === "unavailable") return "Unavailable";
  return "Unknown";
}

function eventName(item) {
  const title = item?.event?.eventTitle || "Voting event";
  const code = item?.event?.eventCode;
  return code ? `${title} (${code})` : title;
}

function sameEventId(left, right) {
  return Boolean(left && right && String(left).toLowerCase() === String(right).toLowerCase());
}

function EventSwitcher({ events, selectedEventId, onSelect, loading = false }) {
  if (!events.length) return null;
  const selected = events.find((item) => sameEventId(item.eventId, selectedEventId)) || events[0];

  return (
    <section className="event-switcher" aria-label="Voting event selector">
      <div className="event-switcher-copy">
        <span className="section-kicker">Active workspace</span>
        <strong>{eventName(selected)}</strong>
        <span>{selected?.event?.issuerName || "Select a voting event"}</span>
      </div>

      <div className="event-switcher-control">
        <label htmlFor="voting-event-select">Voting event</label>
        <select
          id="voting-event-select"
          value={selected?.eventId || selectedEventId || ""}
          disabled={loading || !events.length}
          onChange={(event) => onSelect(event.target.value)}
        >
          {events.map((item) => (
            <option key={item.eventId} value={item.eventId}>
              {eventName(item)} · {eventStatusLabel(item.status)}
            </option>
          ))}
        </select>
      </div>

      <StatusPill tone={eventTone(selected?.status)}>
        {eventStatusLabel(selected?.status)}
      </StatusPill>
    </section>
  );
}

function InvestorEventsPanel({ events, selectedEventId, onOpenEvent }) {
  if (!events.length) return null;

  return (
    <section className="panel investor-events-panel">
      <div className="panel-head">
        <div>
          <div className="section-kicker">My voting events</div>
          <h2>Eligible and participated events</h2>
        </div>
        <StatusPill tone="info">{events.length}</StatusPill>
      </div>

      <div className="investor-event-grid">
        {events.map((item) => {
          const selected = sameEventId(item.eventId, selectedEventId);
          const eligibility = item.eligibility || {};
          const action = item.status === "closed"
            ? "View results"
            : eligibility.hasVoted
              ? "View submission"
              : eligibility.eligible
                ? "Open ballot"
                : "Open event";

          return (
            <article
              className={`investor-event-card ${selected ? "selected" : ""}`}
              key={item.eventId}
            >
              <div className="investor-event-card-head">
                <div>
                  <span>{item.event?.eventCode || "Event"}</span>
                  <strong>{item.event?.eventTitle || "Voting event"}</strong>
                </div>
                <StatusPill tone={eventTone(item.status)}>
                  {eventStatusLabel(item.status)}
                </StatusPill>
              </div>

              <div className="investor-event-card-data">
                <span>{eligibility.viewOnlyReason || "View-only"}</span>
                <strong>
                  {tokenLabel(
                    eligibility.effectiveVotingPower,
                    item.event?.tokenSymbol || eligibility.tokenSymbol
                  )}
                </strong>
              </div>

              <button
                type="button"
                className={eligibility.eligible || eligibility.hasVoted ? "primary-button" : "secondary-button"}
                onClick={() => onOpenEvent(item)}
              >
                {action}
              </button>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function OperationModal({ operation }) {
  if (!operation) return null;
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className={`modal-card ${operation.tone || "success"}`}>
        <div className="modal-icon" aria-hidden="true">{operation.tone === "danger" ? "!" : "✓"}</div>
        <div>
          <div className="section-kicker">{operation.kicker || "Status"}</div>
          <h2>{operation.title}</h2>
          {operation.text && <p>{operation.text}</p>}
          {operation.progress !== undefined && (
            <div className="operation-progress" aria-hidden="true">
              <div className="bar-track">
                <div className="bar-fill" style={{ width: `${operation.progress}%` }} />
              </div>
            </div>
          )}
          {operation.txHash && (
            <div className="tx-proof">
              <span>Transaction</span>
              <strong>{operation.txHash}</strong>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Icon({ size = 18, strokeWidth = 1.7, children }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

const HomeIcon = (p) => <Icon {...p}><path d="M4 11.5 12 5l8 6.5" /><path d="M6.5 10.5V19h11v-8.5" /><path d="M10 19v-5h4v5" /></Icon>;
const VoteIcon = (p) => <Icon {...p}><rect x="4" y="4" width="16" height="16" rx="2" /><path d="m8.5 12 2.2 2.2 4.8-5" /></Icon>;
const ResultsIcon = (p) => <Icon {...p}><path d="M4 19V5" /><path d="M4 19h16" /><path d="M8 16v-5" /><path d="M12 16V8" /><path d="M16 16v-7" /></Icon>;
const WalletIcon = (p) => <Icon {...p}><rect x="3.5" y="6" width="17" height="12" rx="2.5" /><path d="M16 12.5h2" /><path d="M6 9.2h6" /></Icon>;
const LockIcon = (p) => <Icon {...p}><rect x="5" y="10" width="14" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></Icon>;
const ShieldIcon = (p) => <Icon {...p}><path d="M12 3 5 6v5c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6l-7-3Z" /><path d="m9.5 12 1.8 1.8L15 10" /></Icon>;
const DelegateIcon = (p) => <Icon {...p}><circle cx="8" cy="8" r="3" /><circle cx="16" cy="16" r="3" /><path d="M10.5 10.5 13.5 13.5" /><path d="M16 5h3v3" /><path d="M19 5 14 10" /></Icon>;
const ClockIcon = (p) => <Icon {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Icon>;
const AddIcon = (p) => <Icon {...p}><path d="M12 5v14" /><path d="M5 12h14" /></Icon>;

function RotatingHeadline({ phrases = WELCOME_HEADLINES, interval = 4200 }) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (phrases.length <= 1) return undefined;
    const id = window.setInterval(() => setIndex((current) => (current + 1) % phrases.length), interval);
    return () => window.clearInterval(id);
  }, [phrases.length, interval]);

  return (
    <div className="welcome-headline-wrap">
      <h1 className="welcome-headline" key={index} aria-live="polite">{phrases[index]}</h1>
    </div>
  );
}

function Shell({ config, account, eligibility, onConnect, onDisconnect, children }) {
  const navItems = [
    { to: "/", label: "Portal", icon: HomeIcon, end: true },
    { to: "/vote", label: "Vote", icon: VoteIcon },
    { to: "/results", label: "Results", icon: ResultsIcon },
    { separator: true },
    { to: "/admin", label: "Admin", icon: LockIcon, privileged: true },
    { to: "/issuer", label: "Issuer", icon: ShieldIcon, privileged: true },
    { to: "/transfer-agent", label: "Transfer Agent", icon: ShieldIcon, privileged: true },
    { to: "/inspector", label: "Inspector", icon: LockIcon, privileged: true },
    { to: "/proxy-solicitor", label: "Proxy Solicitor", icon: LockIcon, privileged: true }
  ];
  const tone = eligibility?.eligible ? "success" : account ? "info" : "neutral";
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-head">
          <span className="sidebar-eyebrow">Investor Communications</span>
          <span className="sidebar-title">Proxy Voting</span>
        </div>
        <nav className="sidebar-nav" aria-label="Main navigation">
          {navItems.map((item, index) => {
            if (item.separator) return <div key={`sep-${index}`} className="sidebar-secure-separator" aria-hidden="true" />;
            const { to, label, icon: ItemIcon, end, privileged } = item;
            return (
              <NavLink key={to} to={to} end={end} className={`sidebar-link ${privileged ? "privileged-sidebar-link" : ""}`}>
                <ItemIcon size={18} />
                <span>{label}</span>
                {privileged && <em className="privileged-nav-mark" aria-label="Privileged access">●</em>}
              </NavLink>
            );
          })}
        </nav>
        <div className="sidebar-foot">
          <img className="sidebar-logo" src="/broadridge-logo-white.png" alt="Broadridge" onError={(event) => { event.currentTarget.style.display = "none"; }} />
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="topbar-title">
            <span className="topbar-eyebrow">Broadridge</span>
            <strong>{config?.event?.eventTitle || "Proxy Voting"}</strong>
          </div>
          <div className="wallet-controls">
            <button type="button" className="wallet-button" onClick={onConnect}>
              <span className={`status-dot ${tone}`} />
              <WalletIcon size={16} />
              {account ? shortAddress(account) : "Connect wallet"}
            </button>
            {account && (
              <button type="button" className="wallet-disconnect" onClick={onDisconnect}>
                Disconnect
              </button>
            )}
          </div>
        </header>
        <main className="content">
          <div className="content-inner">{children}</div>
          <footer className="footer">
            <div>© {new Date().getFullYear()} Broadridge Financial Solutions, Inc. All Rights Reserved.</div>
            <div className="footer-links"><a href="#">Terms of Use</a><a href="#">Legal Statements</a></div>
          </footer>
        </main>
      </div>
    </div>
  );
}

function RoleGate({ role, children }) {
  const [unlocked, setUnlocked] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const label = ROLE_META[role]?.[0] || role;

  useEffect(() => {
    clearRoleToken(role);
    return () => {
      clearRoleToken(role);
    };
  }, [role]);

  async function submit(event) {
    event.preventDefault();
    try {
      setError("");
      await loginRole(role, password);
      setUnlocked(true);
      setPassword("");
    } catch (unlockError) {
      setError(unlockError.message);
    }
  }

  if (!unlocked) {
    return (
      <section className="panel empty-state privileged-login">
        <div className="empty-icon privileged-icon"><LockIcon size={18} /></div>
        <div className="section-kicker">Protected access</div>
        <h1>{label}</h1>
        <form className="portal-form compact" onSubmit={submit}>
          <label className="form-field"><span>Password</span><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
          <button className="primary-button" disabled={!password}>Unlock</button>
          {error && <div className="notice danger">{error}</div>}
        </form>
      </section>
    );
  }

  return (
    <div className="page-stack privileged-scope">
      <div className="page-heading privileged-heading">
        <div><div className="section-kicker">Protected workspace</div><h1>{label}</h1></div>
        <div className="privileged-actions">
          <span className="privileged-badge"><LockIcon size={13} /> Privileged</span>
          <button className="secondary-button" onClick={() => { clearRoleToken(role); setUnlocked(false); }}>Lock</button>
        </div>
      </div>
      {children}
    </div>
  );
}

function EventSummary({ config }) {
  if (!config?.deployed) {
    return (
      <section className="panel empty-state">
        <div className="empty-icon">—</div>
        <h1>No voting event selected</h1>
      </section>
    );
  }

  const symbol = config.event.tokenSymbol;
  const status = config.status || (config.voting.resultsAvailable ? "closed" : "open");
  return (
    <section className="panel">
      <div className="panel-head">
        <div className="panel-head-main">
          <span className="panel-icon" aria-hidden="true"><ShieldIcon size={18} /></span>
          <div><div className="section-kicker">Voting event</div><h2>{config.event.eventTitle}</h2></div>
        </div>
        <StatusPill tone={eventTone(status)}>{eventStatusLabel(status)}</StatusPill>
      </div>
      <div className="data-list">
        <DataRow label="Issuer" value={config.event.issuerName} />
        <DataRow label="Event code" value={config.event.eventCode} />
        <DataRow label="Token" value={`${config.event.tokenName} (${symbol})`} />
        <DataRow label="Record date supply" value={tokenLabel(config.tokenSnapshot?.totalSnapshotSupply, symbol)} />
        <DataRow label="Opens" value={timeLabel(config.voting.startTimestamp)} />
        <DataRow label="Closes" value={timeLabel(config.voting.endTimestamp)} />
      </div>
    </section>
  );
}

function WalletPanel({ account, eligibility, config, onConnect, onVote, onAddToken, refresh }) {
  const symbol = config?.event?.tokenSymbol || eligibility?.tokenSymbol || "";
  if (!account) {
    return (
      <section className="panel empty-state">
        <div className="empty-icon"><WalletIcon size={18} /></div>
        <h1>Investor portal</h1>
        <button className="primary-button" onClick={onConnect}>Connect wallet</button>
      </section>
    );
  }
  const tone = eligibility?.eligible ? "success" : eligibility?.accessMode === "blocked" ? "danger" : "info";
  return (
    <section className={`panel wallet-panel ${tone}`}>
      <div className="panel-head">
        <div className="wallet-head-left"><span className={`wallet-indicator ${tone}`}><WalletIcon size={18} /></span><div><div className="section-kicker">Wallet</div><h2>{shortAddress(account)}</h2></div></div>
        <StatusPill tone={tone}>{eligibility?.accessMode || "view-only"}</StatusPill>
      </div>
      <div className="data-list">
        <DataRow label="Token balance" value={tokenLabel(eligibility?.balance, symbol)} />
        <DataRow label="Record-date power" value={tokenLabel(eligibility?.snapshotBalance, symbol)} />
        <DataRow label="Delegated power" value={tokenLabel(eligibility?.delegatedPower, symbol)} />
        <DataRow label="Effective power" value={tokenLabel(eligibility?.effectiveVotingPower, symbol)} />
        <DataRow label="Status" value={eligibility?.viewOnlyReason || "—"} />
        <DataRow label="Delegate" value={eligibility?.delegateTo ? shortAddress(eligibility.delegateTo) : "—"} />
      </div>
      <div className="portal-actions">
        <button className="secondary-button" disabled={!eligibility?.tokenAddress} onClick={onAddToken}>Add token</button>
        <button className="primary-button" disabled={!eligibility?.eligible} onClick={onVote}>Vote</button>
        <button className="secondary-button" onClick={refresh}>Refresh</button>
      </div>
    </section>
  );
}

function DelegatePanel({ account, eligibility, config, eventId, refresh, walletProvider, setOperation }) {
  const [delegatee, setDelegatee] = useState("");
  const symbol = config?.event?.tokenSymbol || eligibility?.tokenSymbol || "";
  useEffect(() => {
    setDelegatee("");
  }, [eventId]);

  const canDelegate = Boolean(
    account &&
    eventId &&
    eligibility?.snapshotCreated &&
    Number(eligibility?.snapshotBalance || 0) > 0 &&
    !eligibility?.hasVoted &&
    !eligibility?.hasDelegated &&
    !config?.voting?.resultsAvailable
  );

  async function submitDelegation() {
    try {
      setOperation({ kicker: "Delegation", title: "Awaiting signature", progress: 35 });
      await ensureHardhatNetwork(walletProvider);
      const payload = await buildDelegation(account, delegatee, eventId);
      const signature = await signTypedBallot(account, payload.typedDataForWallet, walletProvider);
      setOperation({ kicker: "Delegation", title: "Recording", progress: 75 });
      const relay = await relayDelegation(account, delegatee, payload.message, signature, eventId);
      setOperation({ kicker: "Delegation", title: "Delegated", tone: "success", progress: 100, txHash: relay.txHash });
      setDelegatee("");
      await refresh();
      window.setTimeout(() => setOperation(null), 1800);
    } catch (error) {
      setOperation({ kicker: "Delegation", title: "Rejected", text: error.message, tone: "danger" });
      window.setTimeout(() => setOperation(null), 3000);
    }
  }

  if (!account || !config?.deployed) return null;
  return (
    <section className="panel">
      <div className="panel-head">
        <div className="panel-head-main"><span className="panel-icon" aria-hidden="true"><DelegateIcon size={18} /></span><div><div className="section-kicker">Delegation</div><h2>Voting rights</h2></div></div>
        <StatusPill tone={eligibility?.hasDelegated ? "success" : canDelegate ? "info" : "neutral"}>{eligibility?.hasDelegated ? "Delegated" : "Available"}</StatusPill>
      </div>
      <div className="data-list">
        <DataRow label="Own record-date power" value={tokenLabel(eligibility?.snapshotBalance, symbol)} />
        <DataRow label="Delegated to this wallet" value={tokenLabel(eligibility?.delegatedPower, symbol)} />
      </div>
      <div className="portal-form compact delegate-form">
        <label className="form-field"><span>Delegate wallet</span><input value={delegatee} onChange={(e) => setDelegatee(e.target.value)} placeholder="0x..." /></label>
        <button className="primary-button" disabled={!canDelegate || !delegatee.trim()} onClick={submitDelegation}>Delegate</button>
      </div>
    </section>
  );
}

function InvestorPortal({
  account,
  eligibility,
  config,
  eventId,
  walletEvents,
  onSelectEvent,
  onConnect,
  refresh,
  walletProvider,
  setOperation
}) {
  const navigate = useNavigate();

  async function addToken() {
    if (!eligibility?.tokenAddress) return;
    await watchAsset(
      { address: eligibility.tokenAddress, symbol: eligibility.tokenSymbol, decimals: 18 },
      walletProvider
    ).catch(() => undefined);
  }

  function openWalletEvent(item) {
    onSelectEvent(item.eventId);
    if (item.status === "closed") navigate("/results");
    else if (item.eligibility?.eligible || item.eligibility?.hasVoted) navigate("/vote");
    else navigate("/");
  }

  return (
    <div className="page-stack home-stack">
      <section className="home-welcome">
        <RotatingHeadline />
        <div className="home-actions">
          <button className="primary-button" onClick={account ? () => navigate("/vote") : onConnect}>{account ? "Open ballot" : "Connect wallet"}</button>
          <button className="secondary-button" onClick={() => navigate("/results")}>Results</button>
        </div>
      </section>

      {account && (
        <InvestorEventsPanel
          events={walletEvents}
          selectedEventId={eventId}
          onOpenEvent={openWalletEvent}
        />
      )}

      {config?.deployed && (
        <div className="split-grid dashboard-grid">
          <EventSummary config={config} />
          <WalletPanel account={account} eligibility={eligibility} config={config} onConnect={onConnect} onVote={() => navigate("/vote")} onAddToken={addToken} refresh={refresh} />
        </div>
      )}
      {config?.deployed && <DelegatePanel account={account} eligibility={eligibility} config={config} eventId={eventId} refresh={refresh} walletProvider={walletProvider} setOperation={setOperation} />}
      {!config?.deployed && <EventSummary config={config} />}
    </div>
  );
}

function RegisterTable({ rows = [], symbol = "" }) {
  return (
    <section className="panel">
      <div className="panel-head"><div><div className="section-kicker">Register</div><h2>Shareholder records</h2></div></div>
      <div className="portal-table-wrap">
        <table className="portal-table">
          <thead><tr><th>Wallet</th><th>Owner</th><th>Shares</th><th>Token</th><th>Snapshot</th><th>Delegate</th><th>Status</th></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.wallet}>
                <td>{shortAddress(row.wallet)}</td>
                <td>{row.beneficialOwner || row.label || "—"}</td>
                <td>{tokenLabel(row.recordedShares, symbol)}</td>
                <td>{tokenLabel(row.tokenBalance || row.balance, symbol)}</td>
                <td>{tokenLabel(row.snapshotBalance, symbol)}</td>
                <td>{row.delegateTo ? shortAddress(row.delegateTo) : "—"}</td>
                <td>{row.blacklisted ? "Blocked" : row.hasVoted ? "Voted" : row.delegateTo ? "Delegated" : row.whitelisted ? "Registered" : "View-only"}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan="7">No records</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ProposalBlock({ proposal, choice, onChange, locked }) {
  return (
    <div className="proposal-block">
      <div className="proposal-info"><span className="proposal-tag">Proposal {proposal.id + 1}</span><strong>{proposal.question}</strong></div>
      <div className="option-row">
        {proposal.options.map((option, index) => (
          <label className={`option ${choice === index ? "selected" : ""} ${locked ? "locked" : ""}`} key={`${proposal.id}-${option}`}>
            <input type="radio" name={`proposal-${proposal.id}`} checked={choice === index} disabled={locked} onChange={() => onChange(proposal.id, index)} />
            <span className="option-control" aria-hidden="true" />
            <span>{option}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

function VotePage({ account, eligibility, config, eventId, onConnect, refresh, setOperation, walletProvider }) {
  const navigate = useNavigate();
  const proposals = config?.proposals || [];
  const [choices, setChoices] = useState([]);
  const [voteTxHash, setVoteTxHash] = useState("");
  const [currentTimestamp, setCurrentTimestamp] = useState(() =>
    Math.floor(Date.now() / 1000)
  );
  const complete = proposals.length > 0 && choices.length === proposals.length && choices.every((choice) => choice !== null && choice !== undefined);
  const selected = choices.filter((choice) => choice !== null && choice !== undefined).length;
  const progress = proposals.length ? Math.round((selected / proposals.length) * 100) : 0;
  const symbol = config?.event?.tokenSymbol || eligibility?.tokenSymbol || "";
  const votingContractAddress = config?.contracts?.voting;

const voteReceiptStorageKey =
  account && votingContractAddress
    ? `broadridge_vote_tx_${account.toLowerCase()}_${votingContractAddress.toLowerCase()}`
    : null;

const blockExplorerBaseUrl =
  config?.network?.blockExplorerUrl ||
  "https://amoy.polygonscan.com";

const voteTransactionUrl = voteTxHash
  ? `${blockExplorerBaseUrl}/tx/${voteTxHash}`
  : "";

const votingEndTimestamp = Number(
  config?.voting?.endTimestamp || 0
);

const votingHasEnded =
  Boolean(config?.voting?.resultsAvailable) ||
  (votingEndTimestamp > 0 &&
    currentTimestamp >= votingEndTimestamp);

const recordedVoteTxHash =
  sameEventId(eligibility?.eventId, eventId)
    ? eligibility?.voteTxHash || ""
    : "";

const showVoteVerification = Boolean(
  voteTxHash &&
  !votingHasEnded
);

  useEffect(() => {
    setChoices(proposals.map(() => null));
  }, [config?.eventId, proposals.length]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setCurrentTimestamp(Math.floor(Date.now() / 1000));
    }, 30000);

    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!voteReceiptStorageKey) {
      setVoteTxHash("");
      return;
    }

    if (votingHasEnded) {
      window.localStorage.removeItem(voteReceiptStorageKey);
      setVoteTxHash("");
      return;
    }

    const savedTxHash =
      recordedVoteTxHash ||
      window.localStorage.getItem(voteReceiptStorageKey) ||
      "";

    if (recordedVoteTxHash) {
      window.localStorage.setItem(voteReceiptStorageKey, recordedVoteTxHash);
    }

    setVoteTxHash(savedTxHash);
  }, [recordedVoteTxHash, voteReceiptStorageKey, votingHasEnded]);

  function select(proposalId, optionId) {
    setChoices((current) => current.map((choice, index) => (index === proposalId ? optionId : choice)));
  }

  async function submit() {
    try {
      setOperation({ kicker: "Ballot", title: "Awaiting signature", progress: 45 });
      await ensureHardhatNetwork(walletProvider);
      const numericChoices = choices.map(Number);
      const signerAccount = await activeWalletAccount(walletProvider);
      if (!signerAccount) throw new Error("No active wallet account found. Reconnect your wallet and try again.");

      const ballot = await buildBallot(signerAccount, numericChoices, eventId);
      const signedMessage = {
        ...ballot.message,
        ...ballot.typedDataForWallet.message,
        choicesArray: numericChoices
      };
      const signature = await signTypedBallot(signerAccount, ballot.typedDataForWallet, walletProvider);
      setOperation({ kicker: "Ballot", title: "Submitting", progress: 80 });
const relay = await relayVote(
  signerAccount,
  numericChoices,
  signedMessage,
  signature,
  eventId
);

if (!relay?.txHash) {
  throw new Error(
    "The vote was submitted, but no transaction hash was returned."
  );
}

setVoteTxHash(relay.txHash);

if (voteReceiptStorageKey) {
  window.localStorage.setItem(
    voteReceiptStorageKey,
    relay.txHash
  );
}

setOperation({
  kicker: "Ballot",
  title: "Submitted",
  text: "Your vote was successfully recorded on Polygon.",
  tone: "success",
  progress: 100,
  txHash: relay.txHash,
});
      await refresh();
      window.setTimeout(() => setOperation(null), 1800);
    } catch (error) {
      setOperation({ kicker: "Ballot", title: "Rejected", text: error.message, tone: "danger" });
      window.setTimeout(() => setOperation(null), 3000);
    }
  }

  if (!config?.deployed) return <EventSummary config={config} />;
  if (!account) return <section className="panel empty-state"><div className="empty-icon"><WalletIcon size={18} /></div><h1>Investor portal</h1><button className="primary-button" onClick={onConnect}>Connect wallet</button></section>;
  if (!eligibility?.eligible && !eligibility?.hasVoted) {
    return (
      <section className="panel empty-state">
        <div className="empty-icon">—</div>
        <h1>{eligibility?.viewOnlyReason || "View-only"}</h1>
        <button className="secondary-button" onClick={() => navigate("/")}>Portal</button>
      </section>
    );
  }

  return (
    <div className="page-stack">
      <div className="page-heading">
        <div><div className="section-kicker">Ballot</div><h1>{config.event.eventTitle}</h1><p>{tokenLabel(eligibility.effectiveVotingPower, symbol)}</p></div>
        <StatusPill tone={complete ? "success" : "info"}>{progress}%</StatusPill>
      </div>
      <div className="ballot-progress"><div className="bar-track"><div className="bar-fill" style={{ width: `${progress}%` }} /></div><span>{selected}/{proposals.length}</span></div>
      <section className="panel proposals-panel">
        {proposals.map((proposal, index) => <div className={`proposal-wrap ${index === 0 ? "first" : ""}`} key={proposal.id}><ProposalBlock proposal={proposal} choice={choices[proposal.id]} onChange={select} locked={eligibility?.hasVoted} /></div>)}
      </section>
      <div className="submit-bar">
        <div>
          <strong>
            {eligibility?.hasVoted
              ? "Vote submitted"
              : complete
                ? "Ready"
                : "Incomplete"}
          </strong>
          {eligibility?.hasVoted && (
            <p>Your ballot has been permanently recorded.</p>
          )}
        </div>

        <button
          className="primary-button"
          disabled={!complete || eligibility?.hasVoted || votingHasEnded}
          onClick={submit}
        >
          {eligibility?.hasVoted
            ? "Already voted"
            : votingHasEnded
              ? "Voting closed"
              : "Approve / sign ballot"}
        </button>
      </div>

      {showVoteVerification && (
        <div className="vote-verification-notice" role="status">
          <span className="vote-verification-icon" aria-hidden="true">
            i
          </span>

          <div className="vote-verification-content">
            <span>You can independently verify your vote submission.</span>

            <a
              href={voteTransactionUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="vote-verification-link"
            >
              View your transaction on PolygonScan
              <span aria-hidden="true"> ↗</span>
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

function ResultGraphic({ proposal, symbol }) {
  const values = (proposal.result || []).map(Number);
  const total = values.reduce((sum, value) => sum + value, 0);
  const winnerIndex = values.reduce((best, value, index) => value > values[best] ? index : best, 0);
  const winnerValue = values[winnerIndex] || 0;
  const winnerPct = total ? (winnerValue / total) * 100 : 0;
  return (
    <section className="panel result-panel result-visual-card">
      <div className="result-visual-head">
        <div className="proposal-info"><span className="proposal-tag">Proposal {proposal.id + 1}</span><strong>{proposal.question}</strong></div>
        <div className="result-ring" style={{ "--pct": `${winnerPct}%` }}><span>{Math.round(winnerPct)}%</span></div>
      </div>
      <div className="winner-strip"><span>Leading option</span><strong>{proposal.options[winnerIndex] || "—"}</strong><em>{tokenLabel(winnerValue, symbol)}</em></div>
      <div className="bar-stack">
        {proposal.options.map((option, index) => {
          const value = values[index] || 0;
          const width = total ? (value / total) * 100 : 0;
          return (
            <div className="bar-row result-row" key={option}>
              <div className="bar-label"><span>{option}</span><strong>{tokenLabel(value, symbol)}</strong></div>
              <div className="bar-track"><div className="bar-fill" style={{ width: `${width}%` }} /></div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function ResultsPage({ config, eventId }) {
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);
  const symbol = config?.event?.tokenSymbol || "";

  const load = useCallback(async () => {
    if (!eventId) {
      setResults(null);
      return;
    }
    try {
      setError(null);
      setResults(await getResults(eventId));
    } catch (loadError) {
      setError(loadError.message);
    }
  }, [eventId]);

  useEffect(() => {
    setResults(null);
    load();
    const id = window.setInterval(load, 5000);
    return () => window.clearInterval(id);
  }, [load]);

  if (!config?.deployed) return <EventSummary config={config} />;
  if (error) return <div className="notice danger">{error}</div>;
  if (!results?.available) return <section className="panel empty-state"><div className="empty-icon">LOCK</div><h1>Results locked</h1></section>;
  return (
    <div className="page-stack">
      <div className="page-heading"><div><div className="section-kicker">Results</div><h1>{config.event.eventTitle}</h1></div><StatusPill tone="success">Final</StatusPill></div>
      <section className="results-summary-grid">
        <div className="panel result-metric"><span>Power cast</span><strong>{tokenLabel(config.voting?.totalVotingPowerCast, symbol)}</strong></div>
        <div className="panel result-metric"><span>Snapshot supply</span><strong>{tokenLabel(config.tokenSnapshot?.totalSnapshotSupply, symbol)}</strong></div>
        <div className="panel result-metric"><span>Quorum</span><strong>{config.voting?.quorumAchieved ? "Achieved" : "Pending"}</strong></div>
      </section>
      {results.proposals.map((proposal) => <ResultGraphic proposal={proposal} symbol={symbol} key={proposal.id} />)}
    </div>
  );
}

function EventSetupForm({ config, refresh, onEventCreated, setOperation }) {
  const defaultStart = inputFromUnix(Math.floor(Date.now() / 1000) + 60);
  const defaultEnd = inputFromUnix(Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60);
  const [form, setForm] = useState({ issuerName: "", eventTitle: "", eventCode: "", tokenName: "", tokenSymbol: "", votingStart: defaultStart, votingEnd: defaultEnd, quorumBps: "5000" });
  const [proposal, setProposal] = useState(EMPTY_PROPOSAL);
  const [proposals, setProposals] = useState([]);
  const [deploying, setDeploying] = useState(false);

  function update(key, value) { setForm((current) => ({ ...current, [key]: value })); }
  function updateOption(index, value) { setProposal((current) => ({ ...current, options: current.options.map((option, i) => i === index ? value : option) })); }
  function addProposal() {
    const next = { question: proposal.question.trim(), options: proposal.options.map((option) => option.trim()).filter(Boolean) };
    if (!next.question || next.options.length < 2) return;
    setProposals((current) => [...current, next]);
    setProposal(EMPTY_PROPOSAL);
  }
  async function deploy() {
    if (deploying) return;
    setDeploying(true);
    try {
      setOperation({ kicker: "Deployment", title: "Deploying", progress: 25 });
      const payload = { ...form, votingStartTimestamp: unixFromInput(form.votingStart), votingEndTimestamp: unixFromInput(form.votingEnd), proposals };
      const response = await deployContracts("admin", payload);
      const createdEventId = response.eventId || response.deployment?.eventId || response.deployment?.contracts?.voting;
      setOperation({ kicker: "Deployment", title: "Deployed", tone: "success", progress: 100 });
      if (createdEventId) await onEventCreated(createdEventId);
      else await refresh();
      window.setTimeout(() => setOperation(null), 1800);
    } catch (error) {
      setOperation({ kicker: "Deployment", title: "Failed", text: error.message, tone: "danger" });
      window.setTimeout(() => setOperation(null), 3500);
    } finally {
      setDeploying(false);
    }
  }
  return (
    <section className="panel">
      <div className="panel-head"><div><div className="section-kicker">Event setup</div><h2>New voting event</h2></div><StatusPill tone={config?.deployed ? "success" : "info"}>{config?.deployed ? "Deployed" : "New"}</StatusPill></div>
      <div className="portal-form-grid">
        <label className="form-field"><span>Issuer</span><input value={form.issuerName} onChange={(e) => update("issuerName", e.target.value)} /></label>
        <label className="form-field"><span>Event title</span><input value={form.eventTitle} onChange={(e) => update("eventTitle", e.target.value)} /></label>
        <label className="form-field"><span>Event code</span><input value={form.eventCode} onChange={(e) => update("eventCode", e.target.value)} /></label>
        <label className="form-field"><span>Token name</span><input value={form.tokenName} onChange={(e) => update("tokenName", e.target.value)} /></label>
        <label className="form-field"><span>Token symbol</span><input value={form.tokenSymbol} onChange={(e) => update("tokenSymbol", e.target.value.toUpperCase())} /></label>
        <label className="form-field"><span>Quorum bps</span><input value={form.quorumBps} onChange={(e) => update("quorumBps", e.target.value)} /></label>
        <label className="form-field"><span>Voting opens</span><input type="datetime-local" value={form.votingStart} onChange={(e) => update("votingStart", e.target.value)} /></label>
        <label className="form-field"><span>Voting closes</span><input type="datetime-local" value={form.votingEnd} onChange={(e) => update("votingEnd", e.target.value)} /></label>
      </div>
      <div className="proposal-editor">
        <label className="form-field"><span>Proposal</span><input value={proposal.question} onChange={(e) => setProposal((current) => ({ ...current, question: e.target.value }))} /></label>
        <div className="portal-form-grid three">
          {proposal.options.map((option, index) => <label className="form-field" key={index}><span>Option {index + 1}</span><input value={option} onChange={(e) => updateOption(index, e.target.value)} /></label>)}
        </div>
        <div className="portal-actions"><button className="secondary-button" onClick={() => setProposal((current) => ({ ...current, options: [...current.options, ""] }))}>Add option</button><button className="secondary-button" onClick={addProposal}>Add proposal</button></div>
      </div>
      <div className="portal-table-wrap mini"><table className="portal-table"><thead><tr><th>#</th><th>Proposal</th><th>Options</th><th></th></tr></thead><tbody>{proposals.map((item, index) => <tr key={`${item.question}-${index}`}><td>{index + 1}</td><td>{item.question}</td><td>{item.options.join(" / ")}</td><td><button className="secondary-button small" onClick={() => setProposals((current) => current.filter((_, i) => i !== index))}>Remove</button></td></tr>)}{!proposals.length && <tr><td colSpan="4">No proposals</td></tr>}</tbody></table></div>
      <div className="portal-actions"><button className="primary-button" disabled={deploying || !proposals.length} onClick={deploy}>{deploying ? "Deploying…" : "Deploy event"}</button></div>
    </section>
  );
}

function AdminPage({ config, refresh, onEventCreated, setOperation }) {
  return <RoleGate role="admin"><EventSetupForm config={config} refresh={refresh} onEventCreated={onEventCreated} setOperation={setOperation} /></RoleGate>;
}

function IssuerPage({ config, eventId, refresh, setOperation }) {
  async function closeEvent() {
    try {
      setOperation({ kicker: "Issuer", title: "Closing event", progress: 70 });
      const response = await endVotingNow("issuer", eventId);
      setOperation({ kicker: "Issuer", title: "Closed", tone: "success", progress: 100, txHash: response.txHash });
      await refresh();
      window.setTimeout(() => setOperation(null), 1800);
    } catch (error) {
      setOperation({ kicker: "Issuer", title: "Failed", text: error.message, tone: "danger" });
      window.setTimeout(() => setOperation(null), 2600);
    }
  }

  return (
    <RoleGate role="issuer">
      <EventSummary config={config} />
      <section className="admin-actions">
        <button
          className="admin-action primary-admin"
          disabled={!eventId || !config?.deployed || config?.voting?.resultsAvailable}
          onClick={closeEvent}
        >
          <span className="admin-action-icon"><ClockIcon size={18} /></span>
          <strong>Close voting</strong>
        </button>
      </section>
    </RoleGate>
  );
}

function TransferAgentPage({ config, eventId, refresh, setOperation }) {
  const [csv, setCsv] = useState(DEFAULT_REGISTER_CSV);
  const symbol = config?.event?.tokenSymbol || "";

  async function run(title, action) {
    try {
      setOperation({ kicker: "Transfer Agent", title, progress: 65 });
      const response = await action();
      setOperation({ kicker: "Transfer Agent", title: "Complete", tone: "success", progress: 100, txHash: response.txHash });
      await refresh();
      window.setTimeout(() => setOperation(null), 1600);
    } catch (error) {
      setOperation({ kicker: "Transfer Agent", title: "Failed", text: error.message, tone: "danger" });
      window.setTimeout(() => setOperation(null), 3000);
    }
  }

  return (
    <RoleGate role="transferAgent">
      <div className="page-stack">
        <section className="panel">
          <div className="panel-head"><div><div className="section-kicker">Register</div><h2>Shareholder register</h2></div></div>
          <textarea className="csv-input" value={csv} onChange={(event) => setCsv(event.target.value)} />
          <div className="portal-actions">
            <button className="primary-button" disabled={!eventId || !csv.trim() || config?.tokenSnapshot?.created} onClick={() => run("Importing", () => importRegister("transferAgent", csv, eventId))}>Import register</button>
            <button className="secondary-button" disabled={!eventId || !config?.deployed || config?.tokenSnapshot?.created} onClick={() => run("Finalizing", () => createSnapshot("transferAgent", eventId))}>Finalize record date</button>
            <button className="secondary-button" type="button" onClick={() => setCsv(DEFAULT_REGISTER_CSV)}>Reset defaults</button>
          </div>
        </section>
        <RegisterTable rows={config?.shareholderRegister || []} symbol={symbol} />
      </div>
    </RoleGate>
  );
}

function InspectorPage({ config, eventId, setOperation }) {
  const [audit, setAudit] = useState(config);

  useEffect(() => {
    setAudit(config);
  }, [config?.eventId, config?.latestBlock?.number]);

  async function refreshAudit() {
    try {
      const response = await getAudit("inspector", eventId);
      setAudit(response.audit);
    } catch (error) {
      setOperation({ kicker: "Inspector", title: "Failed", text: error.message, tone: "danger" });
      window.setTimeout(() => setOperation(null), 2500);
    }
  }

  async function exportAudit() {
    try {
      const response = await exportState("inspector", eventId);
      const blob = new Blob([JSON.stringify(response.payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = response.fileName;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setOperation({ kicker: "Inspector", title: "Failed", text: error.message, tone: "danger" });
      window.setTimeout(() => setOperation(null), 2500);
    }
  }

  const current = audit || config;
  return (
    <RoleGate role="inspector">
      <section className="panel">
        <div className="panel-head">
          <div><div className="section-kicker">Audit</div><h2>Vote integrity</h2></div>
          <div className="portal-actions">
            <button className="secondary-button" disabled={!eventId} onClick={refreshAudit}>Refresh</button>
            <button className="primary-button" disabled={!eventId} onClick={exportAudit}>Export</button>
          </div>
        </div>
        <div className="data-list four">
          <DataRow label="Snapshot supply" value={tokenLabel(current?.tokenSnapshot?.totalSnapshotSupply, current?.event?.tokenSymbol)} />
          <DataRow label="Power cast" value={tokenLabel(current?.voting?.totalVotingPowerCast, current?.event?.tokenSymbol)} />
          <DataRow label="Ballots" value={current?.voting?.totalBallots || 0} />
          <DataRow label="Quorum" value={current?.voting?.quorumAchieved ? "Achieved" : "Pending"} />
        </div>
      </section>
      <RegisterTable rows={current?.shareholderRegister || []} symbol={current?.event?.tokenSymbol} />
    </RoleGate>
  );
}

function SolicitorPage({ config, eventId, setOperation }) {
  const [data, setData] = useState(null);

  useEffect(() => {
    setData(null);
  }, [eventId]);

  async function refreshParticipation() {
    try {
      setData(await getParticipation("solicitor", eventId));
    } catch (error) {
      setOperation({ kicker: "Solicitor", title: "Failed", text: error.message, tone: "danger" });
      window.setTimeout(() => setOperation(null), 2500);
    }
  }

  const pct = data?.participationPct || 0;
  return (
    <RoleGate role="solicitor">
      <section className="panel">
        <div className="panel-head">
          <div><div className="section-kicker">Participation</div><h2>Voting progress</h2></div>
          <button className="primary-button" disabled={!eventId} onClick={refreshParticipation}>Refresh</button>
        </div>
        <div className="bar-track"><div className="bar-fill" style={{ width: `${Math.min(100, pct)}%` }} /></div>
        <div className="data-list four">
          <DataRow label="Participation" value={percent(pct)} />
          <DataRow label="Quorum" value={data?.quorumAchieved ? "Achieved" : "Pending"} />
          <DataRow label="Voted" value={data?.voted || 0} />
          <DataRow label="Pending" value={data?.pending || 0} />
        </div>
      </section>
      <RegisterTable rows={data?.rows || config?.shareholderRegister || []} symbol={config?.event?.tokenSymbol} />
    </RoleGate>
  );
}

export default function App() {
  const navigate = useNavigate();
  const { open } = useAppKit();
  const { disconnect } = useDisconnect();
  const { address, isConnected } = useAppKitAccount({ namespace: "eip155" });
  const { walletProvider } = useAppKitProvider("eip155");

  const appKitAccount = isConnected && address ? address : null;
  const [providerAccount, setProviderAccount] = useState(null);
  const account = providerAccount || appKitAccount;
  const accountRef = useRef(account);
  const connectRequestedRef = useRef(false);

  const [events, setEvents] = useState([]);
  const [walletEvents, setWalletEvents] = useState([]);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [selectedEventId, setSelectedEventId] = useState(() =>
    window.localStorage.getItem(SELECTED_EVENT_KEY) || null
  );
  const selectedEventRef = useRef(selectedEventId);

  const [config, setConfig] = useState(null);
  const [eligibility, setEligibility] = useState(null);
  const [operation, setOperation] = useState(null);

  useEffect(() => {
    accountRef.current = account;
  }, [account]);

  const selectEvent = useCallback((eventId) => {
    const next = eventId || null;
    selectedEventRef.current = next;
    setSelectedEventId(next);
    setConfig(null);
    setEligibility(null);
    if (next) window.localStorage.setItem(SELECTED_EVENT_KEY, next);
    else window.localStorage.removeItem(SELECTED_EVENT_KEY);
  }, []);

  const refreshEvents = useCallback(async ({ preferredEventId = null } = {}) => {
    setEventsLoading(true);
    try {
      const response = await getEvents();
      const nextEvents = (response.events || []).filter((item) => item?.eventId);
      setEvents(nextEvents);

      const requested = preferredEventId || selectedEventRef.current;
      const requestedExists = requested && nextEvents.some((item) => sameEventId(item.eventId, requested));
      const fallback =
        nextEvents.find((item) => item.status === "open") ||
        nextEvents.find((item) => item.status === "pending") ||
        nextEvents[0] ||
        null;
      const nextId = requestedExists ? requested : fallback?.eventId || null;

      if (!sameEventId(nextId, selectedEventRef.current)) selectEvent(nextId);
      return { events: nextEvents, selectedEventId: nextId };
    } finally {
      setEventsLoading(false);
    }
  }, [selectEvent]);

  const loadSelectedEvent = useCallback(async (eventId = selectedEventRef.current) => {
    if (!eventId) {
      setConfig(null);
      setEligibility(null);
      return null;
    }

    const addressAtStart = accountRef.current;
    const [nextConfig, nextEligibility] = await Promise.all([
      getConfig(eventId),
      addressAtStart ? getEligibility(addressAtStart, eventId) : Promise.resolve(null)
    ]);

    if (sameEventId(selectedEventRef.current, eventId)) {
      setConfig(nextConfig);
      if (accountRef.current === addressAtStart) setEligibility(nextEligibility);
    }
    return nextConfig;
  }, []);

  const loadWalletPortfolio = useCallback(async (addressValue = accountRef.current) => {
    if (!addressValue) {
      setWalletEvents([]);
      return [];
    }

    const response = await getWalletEvents(addressValue);
    if (accountRef.current === addressValue) setWalletEvents(response.events || []);
    return response.events || [];
  }, []);

  const refresh = useCallback(async () => {
    const currentEventId = selectedEventRef.current;
    const tasks = [refreshEvents(), currentEventId ? loadSelectedEvent(currentEventId) : Promise.resolve(null)];
    if (accountRef.current) tasks.push(loadWalletPortfolio(accountRef.current));
    const results = await Promise.all(tasks);
    return results[1];
  }, [loadSelectedEvent, loadWalletPortfolio, refreshEvents]);

  const handleEventCreated = useCallback(async (eventId) => {
    selectEvent(eventId);
    await refreshEvents({ preferredEventId: eventId });
    await loadSelectedEvent(eventId);
    if (accountRef.current) await loadWalletPortfolio(accountRef.current);
  }, [loadSelectedEvent, loadWalletPortfolio, refreshEvents, selectEvent]);

  const tokenImportAttemptedRef = useRef(new Set());

  const promptTokenImport = useCallback(async (entry, { force = false } = {}) => {
    if (!accountRef.current || !entry?.hasTokenEntitlement || !entry?.tokenAddress || !walletProvider) return;
    const key = tokenPromptKey(accountRef.current, entry);
    if (!force && key && (tokenImportAttemptedRef.current.has(key) || window.localStorage.getItem(key))) return;
    if (key) {
      tokenImportAttemptedRef.current.add(key);
      window.localStorage.setItem(key, "1");
    }
    await watchAsset({ address: entry.tokenAddress, symbol: entry.tokenSymbol, decimals: 18 }, walletProvider).catch(() => undefined);
  }, [walletProvider]);

  async function handleConnect() {
    try {
      setOperation(null);
      if (account) {
        connectRequestedRef.current = false;
        await open({ view: "Account", namespace: "eip155" });
        return;
      }
      connectRequestedRef.current = true;
      await open({ view: "Connect", namespace: "eip155" });
    } catch (error) {
      connectRequestedRef.current = false;
      setOperation({ kicker: "Wallet", title: "Connection failed", text: error.message, tone: "danger" });
      window.setTimeout(() => setOperation(null), 2600);
    }
  }

  useEffect(() => {
    refreshEvents().catch((error) => {
      setOperation({ kicker: "Events", title: "Load failed", text: error.message, tone: "danger" });
      window.setTimeout(() => setOperation(null), 3000);
    });
  }, [refreshEvents]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      refreshEvents().catch(() => undefined);
      if (accountRef.current) loadWalletPortfolio(accountRef.current).catch(() => undefined);
    }, 30000);

    return () => window.clearInterval(timer);
  }, [loadWalletPortfolio, refreshEvents]);

  useEffect(() => {
    if (!selectedEventId) {
      setConfig(null);
      setEligibility(null);
      return;
    }

    loadSelectedEvent(selectedEventId).catch((error) => {
      if (selectedEventRef.current !== selectedEventId) return;
      setOperation({ kicker: "Event", title: "Load failed", text: error.message, tone: "danger" });
      window.setTimeout(() => setOperation(null), 3000);
    });
  }, [account, selectedEventId, loadSelectedEvent]);

  useEffect(() => {
    if (!walletProvider) {
      setProviderAccount(null);
      return undefined;
    }

    let cancelled = false;

    async function syncProviderAccount() {
      try {
        const active = await activeWalletAccount(walletProvider);
        if (!cancelled) setProviderAccount(active || null);
      } catch (_error) {
        if (!cancelled) setProviderAccount(null);
      }
    }

    syncProviderAccount();

    function handleAccountsChanged(accounts) {
      const nextAccount = accounts?.[0] || null;
      setProviderAccount(nextAccount);
      setEligibility(null);
      setWalletEvents([]);
      connectRequestedRef.current = Boolean(nextAccount);
    }

    function handleChainChanged() {
      syncProviderAccount();
      refresh().catch(() => undefined);
    }

    walletProvider?.on?.("accountsChanged", handleAccountsChanged);
    walletProvider?.on?.("chainChanged", handleChainChanged);

    return () => {
      cancelled = true;
      walletProvider?.removeListener?.("accountsChanged", handleAccountsChanged);
      walletProvider?.removeListener?.("chainChanged", handleChainChanged);
    };
  }, [walletProvider, refresh]);

  useEffect(() => {
    if (!account) {
      setEligibility(null);
      setWalletEvents([]);
      return undefined;
    }

    let cancelled = false;

    async function loadConnectedWallet() {
      try {
        if (walletProvider) await ensureHardhatNetwork(walletProvider);
        const portfolio = await loadWalletPortfolio(account);
        if (cancelled) return;

        const selectedIsRelevant = portfolio.some((item) =>
          sameEventId(item.eventId, selectedEventRef.current)
        );
        const preferred =
          portfolio.find((item) => item.status === "open" && item.eligibility?.eligible) ||
          portfolio.find((item) => item.status === "open") ||
          portfolio.find((item) => item.status === "pending") ||
          portfolio[0];

        if (
          preferred &&
          (connectRequestedRef.current || !selectedEventRef.current || !selectedIsRelevant) &&
          !sameEventId(preferred.eventId, selectedEventRef.current)
        ) {
          selectEvent(preferred.eventId);
        }
      } catch (error) {
        if (!cancelled) {
          connectRequestedRef.current = false;
          setOperation({ kicker: "Wallet", title: "Connection failed", text: error.message, tone: "danger" });
          window.setTimeout(() => setOperation(null), 2600);
        }
      }
    }

    loadConnectedWallet();
    return () => {
      cancelled = true;
    };
  }, [account, walletProvider, loadWalletPortfolio, selectEvent]);

  useEffect(() => {
    if (!account || !eligibility || !sameEventId(eligibility.eventId, selectedEventId)) return;
    if (!connectRequestedRef.current) return;

    promptTokenImport(eligibility).finally(() => {
      connectRequestedRef.current = false;
      navigate("/");
    });
  }, [account, eligibility, navigate, promptTokenImport, selectedEventId]);

  async function handleDisconnect() {
    try {
      await disconnect();
    } catch (_error) {
      // Reown may already be disconnected; clear local view state either way.
    }
    setProviderAccount(null);
    setEligibility(null);
    setWalletEvents([]);
    connectRequestedRef.current = false;
    navigate("/");
  }

  return (
    <Shell config={config} account={account} eligibility={eligibility} onConnect={handleConnect} onDisconnect={handleDisconnect}>
      <OperationModal operation={operation} />
      <EventSwitcher
        events={events}
        selectedEventId={selectedEventId}
        onSelect={selectEvent}
        loading={eventsLoading || Boolean(operation)}
      />
      <Routes>
        <Route path="/" element={<InvestorPortal account={account} eligibility={eligibility} config={config} eventId={selectedEventId} walletEvents={walletEvents} onSelectEvent={selectEvent} onConnect={handleConnect} refresh={refresh} walletProvider={walletProvider} setOperation={setOperation} />} />
        <Route path="/investor" element={<InvestorPortal account={account} eligibility={eligibility} config={config} eventId={selectedEventId} walletEvents={walletEvents} onSelectEvent={selectEvent} onConnect={handleConnect} refresh={refresh} walletProvider={walletProvider} setOperation={setOperation} />} />
        <Route path="/vote" element={<VotePage account={account} eligibility={eligibility} config={config} eventId={selectedEventId} onConnect={handleConnect} refresh={refresh} setOperation={setOperation} walletProvider={walletProvider} />} />
        <Route path="/results" element={<ResultsPage config={config} eventId={selectedEventId} />} />
        <Route path="/admin" element={<AdminPage config={config} refresh={refresh} onEventCreated={handleEventCreated} setOperation={setOperation} />} />
        <Route path="/issuer" element={<IssuerPage config={config} eventId={selectedEventId} refresh={refresh} setOperation={setOperation} />} />
        <Route path="/transfer-agent" element={<TransferAgentPage config={config} eventId={selectedEventId} refresh={refresh} setOperation={setOperation} />} />
        <Route path="/inspector" element={<InspectorPage config={config} eventId={selectedEventId} setOperation={setOperation} />} />
        <Route path="/proxy-solicitor" element={<SolicitorPage config={config} eventId={selectedEventId} setOperation={setOperation} />} />
      </Routes>
    </Shell>
  );
}
