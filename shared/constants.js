const DEFAULT_PROPOSAL_OPTIONS = ["For", "Against", "Abstain"];
const DEFAULT_QUORUM_BPS = 5000;
const DEFAULT_VOTING_DURATION_SECONDS = 7 * 24 * 60 * 60;

const DEFAULT_SHAREHOLDER_REGISTRY = [
  {
    wallet: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    shares: "40",
    label: "Holder 1",
    beneficialOwner: "Investor Alpha",
    custodian: "Demo Custodian A"
  },
  {
    wallet: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
    shares: "25",
    label: "Holder 2",
    beneficialOwner: "Investor Beta",
    custodian: "Demo Custodian A"
  },
  {
    wallet: "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
    shares: "15",
    label: "Holder 3",
    beneficialOwner: "Investor Gamma",
    custodian: "Demo Custodian B"
  },
  {
    wallet: "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",
    shares: "12",
    label: "Holder 4",
    beneficialOwner: "Investor Delta",
    custodian: "Demo Custodian B"
  },
  {
    wallet: "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc",
    shares: "8",
    label: "Holder 5",
    beneficialOwner: "Investor Epsilon",
    custodian: "Demo Custodian C"
  }
];

function defaultRegisterCsv() {
  const header = "Wallet,Shares,Label,BeneficialOwner,Custodian";
  const rows = DEFAULT_SHAREHOLDER_REGISTRY.map((row) =>
    [row.wallet, row.shares, row.label, row.beneficialOwner, row.custodian].join(",")
  );
  return [header, ...rows].join("\n");
}

module.exports = {
  DEFAULT_PROPOSAL_OPTIONS,
  DEFAULT_QUORUM_BPS,
  DEFAULT_VOTING_DURATION_SECONDS,
  DEFAULT_SHAREHOLDER_REGISTRY,
  defaultRegisterCsv
};
