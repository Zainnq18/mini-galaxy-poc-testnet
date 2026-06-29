// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

/// @title DeploymentRegistry
/// @notice Stores the latest live voting-event contract addresses on-chain.
/// @dev This avoids relying on Render's free ephemeral filesystem for deployment persistence.
contract DeploymentRegistry is Ownable {
    struct DeploymentRecord {
        bool deployed;
        uint256 updatedAt;
        uint256 chainId;
        address deployer;
        address accessList;
        address zynToken;
        address voting;
    }

    DeploymentRecord private latest;

    event DeploymentSaved(
        uint256 indexed chainId,
        address indexed voting,
        address indexed deployer,
        address accessList,
        address zynToken,
        uint256 updatedAt
    );

    constructor(address initialOwner) Ownable(initialOwner) {}

    function saveDeployment(
        uint256 chainId,
        address deployer,
        address accessList,
        address zynToken,
        address voting
    ) external onlyOwner {
        require(chainId != 0, "chainId required");
        require(deployer != address(0), "deployer required");
        require(accessList != address(0), "accessList required");
        require(zynToken != address(0), "zynToken required");
        require(voting != address(0), "voting required");

        latest = DeploymentRecord({
            deployed: true,
            updatedAt: block.timestamp,
            chainId: chainId,
            deployer: deployer,
            accessList: accessList,
            zynToken: zynToken,
            voting: voting
        });

        emit DeploymentSaved(chainId, voting, deployer, accessList, zynToken, block.timestamp);
    }

    function latestDeployment() external view returns (DeploymentRecord memory) {
        return latest;
    }
}
