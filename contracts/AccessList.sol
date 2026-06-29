// SPDX-License-Identifier: MIT
// File: contracts/AccessList.sol
// Dynamic transfer-agent shareholder register for tokenised proxy voting.

pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

contract AccessList is Ownable {
    struct ShareholderRecord {
        bool exists;
        bool whitelisted;
        bool blacklisted;
        uint256 shares;
        string label;
        string beneficialOwner;
        string custodian;
    }

    mapping(address => ShareholderRecord) private _records;
    mapping(address => bool) private _listedOnce;
    address[] private _wallets;

    event ShareholderSet(
        address indexed wallet,
        uint256 shares,
        string label,
        string beneficialOwner,
        string custodian
    );
    event ShareholderRemoved(address indexed wallet);
    event BlacklistUpdated(address indexed wallet, bool blacklisted);

    constructor(address initialOwner) Ownable(initialOwner) {}

    function setShareholder(
        address wallet,
        uint256 shares,
        string calldata label,
        string calldata beneficialOwner,
        string calldata custodian
    ) external onlyOwner {
        _setShareholder(wallet, shares, label, beneficialOwner, custodian);
    }

    function setShareholders(
        address[] calldata wallets,
        uint256[] calldata shares,
        string[] calldata labels,
        string[] calldata beneficialOwners,
        string[] calldata custodians
    ) external onlyOwner {
        require(wallets.length == shares.length, "AccessList: wallet/share length");
        require(wallets.length == labels.length, "AccessList: wallet/label length");
        require(wallets.length == beneficialOwners.length, "AccessList: wallet/owner length");
        require(wallets.length == custodians.length, "AccessList: wallet/custodian length");

        for (uint256 i = 0; i < wallets.length; i++) {
            _setShareholder(wallets[i], shares[i], labels[i], beneficialOwners[i], custodians[i]);
        }
    }

    function removeShareholder(address wallet) external onlyOwner {
        require(wallet != address(0), "AccessList: zero wallet");
        ShareholderRecord storage record = _records[wallet];
        record.exists = true;
        record.whitelisted = false;
        record.shares = 0;
        emit ShareholderRemoved(wallet);
    }

    function setBlacklisted(address wallet, bool blacklisted) external onlyOwner {
        require(wallet != address(0), "AccessList: zero wallet");
        _track(wallet);
        ShareholderRecord storage record = _records[wallet];
        record.exists = true;
        record.blacklisted = blacklisted;
        if (blacklisted) {
            record.whitelisted = false;
            record.shares = 0;
        }
        emit BlacklistUpdated(wallet, blacklisted);
    }

    function isWhitelisted(address wallet) external view returns (bool) {
        return _records[wallet].whitelisted;
    }

    function isBlacklisted(address wallet) external view returns (bool) {
        return _records[wallet].blacklisted;
    }

    function shareholdingOf(address wallet) external view returns (uint256) {
        return _records[wallet].shares;
    }

    function getShareholderWallets() external view returns (address[] memory) {
        return _wallets;
    }

    function getShareholderRecord(address wallet)
        external
        view
        returns (
            bool exists,
            bool whitelisted,
            bool blacklisted,
            uint256 shares,
            string memory label,
            string memory beneficialOwner,
            string memory custodian
        )
    {
        ShareholderRecord storage record = _records[wallet];
        return (
            record.exists,
            record.whitelisted,
            record.blacklisted,
            record.shares,
            record.label,
            record.beneficialOwner,
            record.custodian
        );
    }

    function shareholderCount() external view returns (uint256) {
        return _wallets.length;
    }

    function _setShareholder(
        address wallet,
        uint256 shares,
        string memory label,
        string memory beneficialOwner,
        string memory custodian
    ) internal {
        require(wallet != address(0), "AccessList: zero wallet");
        require(shares > 0, "AccessList: zero shares");
        _track(wallet);

        ShareholderRecord storage record = _records[wallet];
        record.exists = true;
        record.whitelisted = true;
        record.blacklisted = false;
        record.shares = shares;
        record.label = label;
        record.beneficialOwner = beneficialOwner;
        record.custodian = custodian;

        emit ShareholderSet(wallet, shares, label, beneficialOwner, custodian);
    }

    function _track(address wallet) internal {
        if (!_listedOnce[wallet]) {
            _wallets.push(wallet);
            _listedOnce[wallet] = true;
        }
    }
}
