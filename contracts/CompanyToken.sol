// SPDX-License-Identifier: MIT
// File: contracts/CompanyToken.sol
// ERC20 company token with transfer-agent entitlement minting and record-date snapshot finalization.

pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./AccessList.sol";

contract CompanyToken is ERC20, Ownable {
    AccessList public immutable accessList;

    bool public recordDateSnapshotCreated;
    uint256 public recordDateSnapshotTimestamp;
    uint256 public totalSnapshotSupply;

    mapping(address => bool) public entitlementMinted;
    mapping(address => uint256) private _snapshotBalances;

    event EntitlementMinted(address indexed wallet, uint256 amount);
    event EntitlementsMassMinted(uint256 holdersProcessed, uint256 amountMinted);
    event RecordDateFinalized(uint256 holdersProcessed, uint256 amountMinted, uint256 totalSnapshotSupply, uint256 timestamp);
    event RecordDateSnapshotCreated(uint256 indexed timestamp, uint256 totalSnapshotSupply);

    constructor(
        string memory tokenName,
        string memory tokenSymbol,
        address accessListAddress,
        address initialOwner
    ) ERC20(tokenName, tokenSymbol) Ownable(initialOwner) {
        require(accessListAddress != address(0), "Token: access list required");
        accessList = AccessList(accessListAddress);
    }

    function mintEntitlement(address wallet) external onlyOwner returns (uint256) {
        require(!recordDateSnapshotCreated, "Token: record date finalized");
        return _mintEntitlement(wallet);
    }

    function massMintEntitlements() external onlyOwner returns (uint256 holdersProcessed, uint256 amountMinted) {
        require(!recordDateSnapshotCreated, "Token: record date finalized");
        (holdersProcessed, amountMinted) = _massMintEntitlements();
        emit EntitlementsMassMinted(holdersProcessed, amountMinted);
    }

    function createRecordDateSnapshot() external onlyOwner returns (uint256 snapshotSupply) {
        require(!recordDateSnapshotCreated, "Token: record date finalized");
        snapshotSupply = _createRecordDateSnapshot();
        emit RecordDateSnapshotCreated(block.timestamp, snapshotSupply);
    }

    function finalizeRecordDate()
        external
        onlyOwner
        returns (uint256 holdersProcessed, uint256 amountMinted, uint256 snapshotSupply)
    {
        require(!recordDateSnapshotCreated, "Token: record date finalized");
        (holdersProcessed, amountMinted) = _massMintEntitlements();
        snapshotSupply = _createRecordDateSnapshot();
        emit EntitlementsMassMinted(holdersProcessed, amountMinted);
        emit RecordDateSnapshotCreated(block.timestamp, snapshotSupply);
        emit RecordDateFinalized(holdersProcessed, amountMinted, snapshotSupply, block.timestamp);
    }

    function snapshotBalanceOf(address wallet) external view returns (uint256) {
        return _snapshotBalances[wallet];
    }

    function _massMintEntitlements() internal returns (uint256 holdersProcessed, uint256 amountMinted) {
        address[] memory holders = accessList.getShareholderWallets();
        for (uint256 i = 0; i < holders.length; i++) {
            uint256 amount = _mintEntitlement(holders[i]);
            if (amount > 0) {
                holdersProcessed += 1;
                amountMinted += amount;
            }
        }
    }

    function _createRecordDateSnapshot() internal returns (uint256 snapshotSupply) {
        address[] memory holders = accessList.getShareholderWallets();
        for (uint256 i = 0; i < holders.length; i++) {
            address holder = holders[i];
            uint256 balance = balanceOf(holder);
            _snapshotBalances[holder] = balance;
            snapshotSupply += balance;
        }
        recordDateSnapshotCreated = true;
        recordDateSnapshotTimestamp = block.timestamp;
        totalSnapshotSupply = snapshotSupply;
    }

    function _mintEntitlement(address wallet) internal returns (uint256) {
        if (wallet == address(0)) return 0;
        if (entitlementMinted[wallet]) return 0;
        if (accessList.isBlacklisted(wallet)) return 0;
        if (!accessList.isWhitelisted(wallet)) return 0;

        uint256 shares = accessList.shareholdingOf(wallet);
        if (shares == 0) return 0;

        entitlementMinted[wallet] = true;
        _mint(wallet, shares);
        emit EntitlementMinted(wallet, shares);
        return shares;
    }
}
