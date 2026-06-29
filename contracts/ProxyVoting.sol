// SPDX-License-Identifier: MIT
// File: contracts/ProxyVoting.sol
// Dynamic EIP-712 gasless proxy voting using record-date ERC20 token snapshots and shareholder delegation.

pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "./AccessList.sol";
import "./CompanyToken.sol";

contract ProxyVoting is Ownable, EIP712 {
    using ECDSA for bytes32;

    uint256 public constant VOTING_ID = 1;
    // The user-facing signed ballot contains the choices array as a string, e.g. "[0,1,2]",
    // plus a deterministic hash of the packed bytes used by the contract. This avoids
    // wallet/contract inconsistencies around EIP-712 dynamic numeric arrays.
    bytes32 private constant BALLOT_TYPEHASH =
        keccak256("Ballot(address voter,uint256 votingId,string choices,bytes32 choicesHash,uint256 nonce,uint256 deadline)");
    bytes32 private constant DELEGATION_TYPEHASH =
        keccak256("Delegation(address delegator,address delegatee,uint256 votingId,uint256 nonce,uint256 deadline)");

    struct Proposal {
        string question;
        string[] options;
    }

    struct VoteReceipt {
        bool submitted;
        uint256 votingPower;
        uint256 submittedAt;
        bytes choices;
    }

    AccessList public immutable accessList;
    CompanyToken public immutable votingToken;

    string public issuerName;
    string public eventTitle;
    string public eventCode;

    uint256 public votingStartTimestamp;
    uint256 public votingEndTimestamp;
    uint256 public totalBallots;
    uint256 public totalVotingPowerCast;
    uint256 public quorumBps;

    Proposal[] private _proposals;
    mapping(address => uint256) public nonces;
    mapping(address => VoteReceipt) private _receipts;
    mapping(uint256 => mapping(uint256 => uint256)) private _weightedTally;

    mapping(address => address) public delegateOf;
    mapping(address => uint256) public delegatedPowerTo;

    event VotingWindowUpdated(uint256 startTimestamp, uint256 endTimestamp);
    event VoteDelegated(address indexed delegator, address indexed delegatee, uint256 votingPower, uint256 timestamp);
    event VoteSubmitted(
        address indexed voter,
        uint256 indexed votingId,
        bytes choices,
        uint256 votingPower,
        uint256 timestamp
    );

    constructor(
        address accessListAddress,
        address tokenAddress,
        string memory issuerName_,
        string memory eventTitle_,
        string memory eventCode_,
        uint256 start_,
        uint256 end_,
        uint256 quorumBps_,
        address initialOwner
    ) Ownable(initialOwner) EIP712("Broadridge Proxy Voting", "1") {
        require(accessListAddress != address(0), "Voting: access list required");
        require(tokenAddress != address(0), "Voting: token required");
        require(bytes(issuerName_).length > 0, "Voting: issuer required");
        require(bytes(eventTitle_).length > 0, "Voting: title required");
        require(end_ > start_, "Voting: invalid window");
        require(quorumBps_ <= 10000, "Voting: invalid quorum");

        accessList = AccessList(accessListAddress);
        votingToken = CompanyToken(tokenAddress);
        issuerName = issuerName_;
        eventTitle = eventTitle_;
        eventCode = eventCode_;
        votingStartTimestamp = start_;
        votingEndTimestamp = end_;
        quorumBps = quorumBps_;
    }


    event ProposalAdded(uint256 indexed proposalId, string question);

    function addProposal(string calldata question, string[] calldata options) external onlyOwner {
        require(bytes(question).length > 0, "Voting: empty question");
        require(options.length >= 2, "Voting: min two options");
        _proposals.push();
        Proposal storage p = _proposals[_proposals.length - 1];
        p.question = question;
        for (uint256 i = 0; i < options.length; i++) {
            require(bytes(options[i]).length > 0, "Voting: empty option");
            p.options.push(options[i]);
        }
        emit ProposalAdded(_proposals.length - 1, question);
    }

    function submitVoteBySig(
        address voter,
        bytes calldata packedChoices,
        string calldata choicesText,
        bytes32 choicesHash,
        uint256 deadline,
        bytes calldata signature
    ) external {
        require(block.timestamp >= votingStartTimestamp, "Voting: not started");
        require(block.timestamp < votingEndTimestamp, "Voting: ended");
        require(block.timestamp <= deadline, "Voting: expired");
        require(!accessList.isBlacklisted(voter), "Voting: blacklisted");
        require(!_receipts[voter].submitted, "Voting: already submitted");
        require(delegateOf[voter] == address(0), "Voting: rights delegated");
        require(votingToken.recordDateSnapshotCreated(), "Voting: no snapshot");
        require(_proposals.length > 0, "Voting: no proposals");
        require(packedChoices.length == _proposals.length, "Voting: choice count");
        require(choicesHash == keccak256(packedChoices), "Voting: choices hash");

        uint256 voterNonce = nonces[voter];
        bytes32 structHash = keccak256(
            abi.encode(
                BALLOT_TYPEHASH,
                voter,
                VOTING_ID,
                keccak256(bytes(choicesText)),
                choicesHash,
                voterNonce,
                deadline
            )
        );
        address recovered = _hashTypedDataV4(structHash).recover(signature);
        require(recovered == voter, "Voting: invalid signature");

        uint256 votingPower = effectiveVotingPower(voter);
        require(votingPower > 0, "Voting: no voting power");

        for (uint256 i = 0; i < packedChoices.length; i++) {
            uint8 choice = uint8(packedChoices[i]);
            require(choice < _proposals[i].options.length, "Voting: invalid choice");
            _weightedTally[i][choice] += votingPower;
        }

        nonces[voter] = voterNonce + 1;
        VoteReceipt storage receipt = _receipts[voter];
        receipt.submitted = true;
        receipt.votingPower = votingPower;
        receipt.submittedAt = block.timestamp;
        receipt.choices = packedChoices;

        totalBallots++;
        totalVotingPowerCast += votingPower;
        emit VoteSubmitted(voter, VOTING_ID, packedChoices, votingPower, block.timestamp);
    }

    function delegateBySig(
        address delegator,
        address delegatee,
        uint256 deadline,
        bytes calldata signature
    ) external {
        require(block.timestamp < votingEndTimestamp, "Voting: ended");
        require(block.timestamp <= deadline, "Voting: expired");
        require(delegator != address(0) && delegatee != address(0), "Voting: zero address");
        require(delegator != delegatee, "Voting: self delegation");
        require(!accessList.isBlacklisted(delegator), "Voting: delegator blacklisted");
        require(!accessList.isBlacklisted(delegatee), "Voting: delegatee blacklisted");
        require(votingToken.recordDateSnapshotCreated(), "Voting: no snapshot");
        require(!_receipts[delegator].submitted, "Voting: delegator voted");
        require(!_receipts[delegatee].submitted, "Voting: delegatee voted");
        require(delegateOf[delegator] == address(0), "Voting: already delegated");

        uint256 votingPower = votingToken.snapshotBalanceOf(delegator);
        require(votingPower > 0, "Voting: no voting power");

        uint256 delegatorNonce = nonces[delegator];
        bytes32 structHash = keccak256(
            abi.encode(DELEGATION_TYPEHASH, delegator, delegatee, VOTING_ID, delegatorNonce, deadline)
        );
        address recovered = _hashTypedDataV4(structHash).recover(signature);
        require(recovered == delegator, "Voting: invalid signature");

        nonces[delegator] = delegatorNonce + 1;
        delegateOf[delegator] = delegatee;
        delegatedPowerTo[delegatee] += votingPower;
        emit VoteDelegated(delegator, delegatee, votingPower, block.timestamp);
    }


    function effectiveVotingPower(address voter) public view returns (uint256) {
        if (delegateOf[voter] != address(0)) return 0;
        uint256 ownPower = votingToken.snapshotBalanceOf(voter);
        return ownPower + delegatedPowerTo[voter];
    }

    function updateVotingWindow(uint256 startTimestamp, uint256 endTimestamp) external onlyOwner {
        require(endTimestamp > startTimestamp, "Voting: invalid window");
        votingStartTimestamp = startTimestamp;
        votingEndTimestamp = endTimestamp;
        emit VotingWindowUpdated(startTimestamp, endTimestamp);
    }

    function endVotingNow() external onlyOwner {
        require(block.timestamp < votingEndTimestamp, "Voting: already ended");
        votingEndTimestamp = block.timestamp;
        emit VotingWindowUpdated(votingStartTimestamp, votingEndTimestamp);
    }

    function hasVoted(address voter) external view returns (bool) {
        return _receipts[voter].submitted;
    }

    function receiptOf(address voter) external view returns (VoteReceipt memory) {
        return _receipts[voter];
    }

    function proposalCount() external view returns (uint256) {
        return _proposals.length;
    }

    function getProposal(uint256 proposalId) external view returns (string memory question, string[] memory options) {
        require(proposalId < _proposals.length, "Voting: invalid proposal");
        Proposal storage p = _proposals[proposalId];
        return (p.question, p.options);
    }

    function getResultForProposal(uint256 proposalId) external view returns (uint256[] memory result) {
        require(block.timestamp >= votingEndTimestamp, "Voting: results locked");
        require(proposalId < _proposals.length, "Voting: invalid proposal");
        Proposal storage p = _proposals[proposalId];
        result = new uint256[](p.options.length);
        for (uint256 i = 0; i < p.options.length; i++) result[i] = _weightedTally[proposalId][i];
    }

    function quorumAchieved() external view returns (bool) {
        uint256 supply = votingToken.totalSnapshotSupply();
        return supply > 0 && ((totalVotingPowerCast * 10000) / supply) >= quorumBps;
    }
}
