// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.20;

/**
 * @title MockStorageQuery
 * @notice Mock implementation of the storage query precompile for testing
 * @dev This mock simulates Substrate storage queries for testing purposes
 */
contract MockStorageQuery {
    bytes16 constant DELEGATES_PREFIX = 0x60d1f0ff648e4c86ea413fc0173d4038; // get validator take
    bytes16 constant TOTAL_HOTKEY_ALPHA_PREFIX =
        0xee25c3b5b1886863480497907f1829e6; // get total hotkey alpha

    uint256 public totalHotkeyAlpha;
    uint256 public delegates;

    function setTotalHotkeyAlpha(uint256 data) external {
        totalHotkeyAlpha = data;
    }

    function setDelegates(uint256 data) external {
        delegates = data;
    }

    fallback(
        bytes calldata _storageKey
    ) external payable returns (bytes memory) {
        bytes memory prefix = new bytes(16);

        for (uint256 i = 0; i < 16; i++) {
            prefix[i] = _storageKey[16 + i];
        }

        bytes16 prefixBytes16 = bytes16(prefix);

        if (prefixBytes16 == DELEGATES_PREFIX) {
            return abi.encode(delegates);
        } else if (prefixBytes16 == TOTAL_HOTKEY_ALPHA_PREFIX) {
            return abi.encode(totalHotkeyAlpha);
        } else {
            revert("Invalid prefix");
        }
    }
}
