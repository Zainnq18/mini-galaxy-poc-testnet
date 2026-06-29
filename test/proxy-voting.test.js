const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Broadridge Proxy Voting Portal", function () {
  async function fixture() {
    const [owner, holder1, holder2, delegatee, blocked] = await ethers.getSigners();
    const Access = await ethers.getContractFactory("AccessList");
    const access = await Access.deploy(owner.address);
    await access.waitForDeployment();

    const Token = await ethers.getContractFactory("CompanyToken");
    const token = await Token.deploy("Example Inc. Tokenised Share", "EXM", await access.getAddress(), owner.address);
    await token.waitForDeployment();

    const now = Math.floor(Date.now() / 1000);
    const Voting = await ethers.getContractFactory("ProxyVoting");
    const voting = await Voting.deploy(
      await access.getAddress(),
      await token.getAddress(),
      "Example Inc.",
      "2026 Annual Meeting",
      "EXM-2026-AGM",
      now - 1,
      now + 3600,
      5000,
      owner.address
    );
    await voting.waitForDeployment();
    await (await voting.addProposal("Elect directors", ["For", "Against", "Abstain"])).wait();
    await (await voting.addProposal("Ratify auditor", ["For", "Against", "Abstain"])).wait();

    await access.setShareholders(
      [holder1.address, holder2.address],
      [ethers.parseEther("60"), ethers.parseEther("40")],
      ["Holder 1", "Holder 2"],
      ["Investor One", "Investor Two"],
      ["Custodian A", "Custodian B"]
    );
    await access.setBlacklisted(blocked.address, true);
    await token.finalizeRecordDate();
    return { owner, holder1, holder2, delegatee, blocked, access, token, voting };
  }

  it("mints ERC20 entitlements and snapshots record-date voting power", async function () {
    const { holder1, holder2, token } = await fixture();
    expect(await token.balanceOf(holder1.address)).to.equal(ethers.parseEther("60"));
    expect(await token.balanceOf(holder2.address)).to.equal(ethers.parseEther("40"));
    expect(await token.snapshotBalanceOf(holder1.address)).to.equal(ethers.parseEther("60"));
  });

  it("accepts one gasless dynamic ballot weighted by effective voting power", async function () {
    const { holder1, token, voting } = await fixture();
    const choices = [0, 1];
    const nonce = await voting.nonces(holder1.address);
    const deadline = Math.floor(Date.now() / 1000) + 900;
    const network = await ethers.provider.getNetwork();
    const choicesText = JSON.stringify(choices);
    const packedChoices = ethers.hexlify(Uint8Array.from(choices));
    const choicesHash = ethers.keccak256(packedChoices);
    const signature = await holder1.signTypedData(
      { name: "Broadridge Proxy Voting", version: "1", chainId: Number(network.chainId), verifyingContract: await voting.getAddress() },
      { Ballot: [
        { name: "voter", type: "address" },
        { name: "votingId", type: "uint256" },
        { name: "choices", type: "string" },
        { name: "choicesHash", type: "bytes32" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" }
      ] },
      { voter: holder1.address, votingId: 1, choices: choicesText, choicesHash, nonce, deadline }
    );
    await voting.submitVoteBySig(holder1.address, packedChoices, choicesText, choicesHash, deadline, signature);
    expect(await voting.hasVoted(holder1.address)).to.equal(true);
    await voting.endVotingNow();
    const result = await voting.getResultForProposal(0);
    expect(result[0]).to.equal(await token.snapshotBalanceOf(holder1.address));
  });

  it("allows a holder to delegate record-date voting power", async function () {
    const { holder1, delegatee, token, voting } = await fixture();
    const nonce = await voting.nonces(holder1.address);
    const deadline = Math.floor(Date.now() / 1000) + 900;
    const network = await ethers.provider.getNetwork();
    const signature = await holder1.signTypedData(
      { name: "Broadridge Proxy Voting", version: "1", chainId: Number(network.chainId), verifyingContract: await voting.getAddress() },
      { Delegation: [
        { name: "delegator", type: "address" },
        { name: "delegatee", type: "address" },
        { name: "votingId", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" }
      ] },
      { delegator: holder1.address, delegatee: delegatee.address, votingId: 1, nonce, deadline }
    );
    await voting.delegateBySig(holder1.address, delegatee.address, deadline, signature);
    expect(await voting.delegateOf(holder1.address)).to.equal(delegatee.address);
    expect(await voting.effectiveVotingPower(delegatee.address)).to.equal(await token.snapshotBalanceOf(holder1.address));
  });
});
