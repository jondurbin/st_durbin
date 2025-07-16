// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.20;

import "forge-std/Test.sol";
import "../src/SaintDurbin.sol";
import "./mocks/MockStaking.sol";
import "./mocks/MockMetagraph.sol";

contract SaintDurbinValidatorSwitchTest is Test {
    SaintDurbin public saintDurbin;
    MockStaking public mockStaking;
    MockMetagraph public mockMetagraph;

    address emergencyOperator = address(0x2);
    address drainAddress = address(0x4);
    bytes32 drainSs58Address = bytes32(uint256(0x999));
    bytes32 validatorHotkey = bytes32(uint256(0x777));
    bytes32 contractSs58Key = bytes32(uint256(0x888));
    uint16 netuid = 1;
    uint16 validatorUid = 123;

    // Additional validators for testing
    bytes32 validator2Hotkey = bytes32(uint256(0x778));
    uint16 validator2Uid = 124;
    bytes32 validator3Hotkey = bytes32(uint256(0x779));
    uint16 validator3Uid = 125;

    bytes32[] recipientColdkeys;
    uint256[] proportions;

    uint256 constant INITIAL_STAKE = 10000e9; // 10,000 TAO

    event ValidatorSwitched(
        bytes32 indexed oldHotkey,
        bytes32 indexed newHotkey,
        uint16 newUid,
        string reason
    );
    event ValidatorCheckFailed(string reason);

    function setUp() public {
        // Deploy mock staking at the expected address
        vm.etch(address(0x805), type(MockStaking).runtimeCode);
        mockStaking = MockStaking(address(0x805));

        // Deploy mock metagraph at the expected address
        vm.etch(address(0x802), type(MockMetagraph).runtimeCode);
        mockMetagraph = MockMetagraph(address(0x802));

        // Setup recipients
        recipientColdkeys = new bytes32[](16);
        proportions = new uint256[](16);

        for (uint256 i = 0; i < 16; i++) {
            recipientColdkeys[i] = bytes32(uint256(0x100 + i));
            proportions[i] = 625; // 6.25% each
        }

        // Set up the initial validator in the metagraph
        mockMetagraph.setValidator(
            netuid,
            validatorUid,
            true,
            true,
            validatorHotkey,
            uint64(1000e9),
            10000
        );
        mockMetagraph.setUidCount(netuid, 130); // Set higher than our test UIDs

        // Set initial stake for the contract
        mockStaking.setStake(
            contractSs58Key,
            validatorHotkey,
            netuid,
            INITIAL_STAKE
        );

        // Deploy SaintDurbin
        saintDurbin = new SaintDurbin(
            emergencyOperator,
            drainAddress,
            drainSs58Address,
            validatorHotkey,
            validatorUid,
            contractSs58Key,
            netuid,
            recipientColdkeys,
            proportions
        );
    }

    function testSelectBestValidator() public {
        // Set up multiple validators with different yield scores
        mockMetagraph.setValidator(
            netuid,
            validator2Uid,
            true,
            true,
            validator2Hotkey,
            uint64(2000e9),
            15000
        );
        mockMetagraph.setEmission(netuid, validator2Uid, uint64(100e9));

        mockMetagraph.setValidator(
            netuid,
            validator3Uid,
            true,
            true,
            validator3Hotkey,
            uint64(1500e9),
            10000
        );
        mockMetagraph.setEmission(netuid, validator3Uid, uint64(150e9));

        vm.expectEmit(true, true, false, true);
        emit ValidatorSwitched(
            validatorHotkey,
            validator3Hotkey,
            validator3Uid,
            "Requested by emergency operator or wallet"
        );

        // Call checkAndSwitchValidator
        vm.prank(emergencyOperator);
        saintDurbin.checkAndSwitchValidator();

        // Verify validator3 was selected (highest yield score)
        assertEq(saintDurbin.currentValidatorHotkey(), validator3Hotkey);
        assertEq(saintDurbin.currentValidatorUid(), validator3Uid);
    }

    function testNoValidValidatorFound() public {
        // All other validators are inactive or don't have permits
        mockMetagraph.setValidator(
            netuid,
            validator2Uid,
            false,
            true,
            validator2Hotkey,
            uint64(2000e9),
            15000
        );
        mockMetagraph.setValidator(
            netuid,
            validator3Uid,
            true,
            false,
            validator3Hotkey,
            uint64(1500e9),
            12000
        );

        // Current validator loses permit
        mockMetagraph.setValidator(
            netuid,
            validatorUid,
            false,
            true,
            validatorHotkey,
            uint64(1000e9),
            10000
        );

        // Expect the check failed event
        vm.expectEmit(false, false, false, true);
        emit ValidatorCheckFailed("No valid validator found");

        // Call checkAndSwitchValidator
        vm.prank(emergencyOperator);
        saintDurbin.checkAndSwitchValidator();

        // Verify validator was NOT switched
        assertEq(saintDurbin.currentValidatorHotkey(), validatorHotkey);
        assertEq(saintDurbin.currentValidatorUid(), validatorUid);
    }

    function testMoveStakeFailure() public {
        // Set up alternative validator with emission
        mockMetagraph.setValidator(
            netuid,
            validator2Uid,
            true,
            true,
            validator2Hotkey,
            uint64(2000e9),
            15000
        );
        mockMetagraph.setEmission(netuid, validator2Uid, uint64(100e9));

        // Current validator loses permit
        mockMetagraph.setValidator(
            netuid,
            validatorUid,
            false,
            true,
            validatorHotkey,
            uint64(1000e9),
            10000
        );

        // Make moveStake fail
        mockStaking.setShouldRevert(true, "Move stake failed");

        // Expect the check failed event
        vm.expectEmit(false, false, false, true);
        emit ValidatorCheckFailed("Failed to move stake to new validator");

        // Call checkAndSwitchValidator
        vm.prank(emergencyOperator);
        saintDurbin.checkAndSwitchValidator();

        // Verify validator was NOT switched due to moveStake failure
        assertEq(saintDurbin.currentValidatorHotkey(), validatorHotkey);
        assertEq(saintDurbin.currentValidatorUid(), validatorUid);
    }
}
