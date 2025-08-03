// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.20;

/**
 * @title MockBlakeTwo128
 * @notice Mock implementation of the Blake2-128 hash function for testing
 * @dev This mock provides deterministic hashing for testing purposes
 */
contract MockBlakeTwo128 {
    bytes16 public data = 0x1234567890abcdef1234567890abcdef;

    fallback(bytes calldata _data) external payable returns (bytes memory) {
        return abi.encode(data);
    }
}
