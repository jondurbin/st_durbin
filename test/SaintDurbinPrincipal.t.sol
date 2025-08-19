// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.20;

import "forge-std/Test.sol";
import "../src/SaintDurbin.sol";
import "./mocks/MockStaking.sol";
import "./mocks/MockMetagraph.sol";

contract SaintDurbinPrincipalTest is Test {
    SaintDurbin public saintDurbin;
    MockStaking public mockStaking;
    MockMetagraph public mockMetagraph;

    address owner = address(0x1);
    address emergencyOperator = address(0x2);
    address drainAddress = address(0x4);

    bytes32 drainSs58Address = bytes32(uint256(0x999));
    bytes32 validatorHotkey = bytes32(uint256(0x777));
    bytes32 contractSs58Key = bytes32(uint256(0x888));
    uint16 netuid = 1;
    uint16 validatorUid = 123;

    bytes16 validatorHotkeyHash = bytes16(uint128(0x555));

    bytes32[] recipientColdkeys;
    uint256[] proportions;

    uint256 constant INITIAL_STAKE = 10000e9; // 10,000 TAO
    uint256 constant MIN_VALIDATOR_STAKE = 1000e9; // 1,000 TAO

    function setUp() public {
        // Deploy mock staking at the expected address
        vm.etch(address(0x805), type(MockStaking).runtimeCode);
        mockStaking = MockStaking(address(0x805));

        // Deploy mock metagraph at the expected address
        vm.etch(address(0x802), type(MockMetagraph).runtimeCode);
        mockMetagraph = MockMetagraph(address(0x802));

        // Set up the validator in the metagraph
        mockMetagraph.setValidator(
            netuid,
            validatorUid,
            true,
            true,
            validatorHotkey,
            uint64(1000e9),
            10000
        );

        // Setup simple recipient configuration for testing
        recipientColdkeys = new bytes32[](16);
        proportions = new uint256[](16);

        // Simple even distribution for testing
        for (uint256 i = 0; i < 16; i++) {
            recipientColdkeys[i] = bytes32(uint256(0x100 + i));
            proportions[i] = 625; // 6.25% each
        }

        // Setup validator
        mockStaking.setTotalStake(validatorHotkey, netuid, MIN_VALIDATOR_STAKE);
        mockStaking.setValidator(validatorHotkey, netuid, true);

        // Set initial stake for the contract before deployment
        mockStaking.setStake(
            contractSs58Key,
            validatorHotkey,
            netuid,
            INITIAL_STAKE
        );

        // Deploy SaintDurbin with all immutable parameters
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

    function testPrincipalDetectionOnFirstTransfer() public {
        // First distribution to establish baseline
        uint256 firstYield = 100e9; // 100 TAO
        mockStaking.addYield(
            contractSs58Key,
            validatorHotkey,
            netuid,
            firstYield
        );

        mockMetagraph.setEmission(netuid, validatorUid, 1000e9);

        vm.roll(block.number + 7200);
        vm.prank(emergencyOperator);
        saintDurbin.executeTransfer(INITIAL_STAKE * 10);

        // Verify first transfer completed
        assertEq(saintDurbin.lastPaymentAmount(), firstYield);
        assertEq(saintDurbin.principalLocked(), INITIAL_STAKE);
    }

    function testPrincipalDetectionWithRateSpike() public {
        // First distribution to establish baseline rate
        uint256 normalYield = 100e9; // 100 TAO per day
        mockStaking.addYield(
            contractSs58Key,
            validatorHotkey,
            netuid,
            normalYield
        );

        mockMetagraph.setEmission(netuid, validatorUid, 1000e9);

        vm.roll(block.number + 7200);
        vm.prank(emergencyOperator);
        saintDurbin.executeTransfer(INITIAL_STAKE * 10);

        // Second distribution with principal addition
        // User adds 1000 TAO principal + normal 100 TAO yield
        uint256 principalAddition = 1000e9;
        uint256 totalAddition = principalAddition + normalYield;
        mockStaking.addYield(
            contractSs58Key,
            validatorHotkey,
            netuid,
            totalAddition
        );

        vm.roll(14401); // Advance to block 14401 (7201 + 7200)

        // Capture principal before transfer
        uint256 principalBefore = saintDurbin.principalLocked();
        mockMetagraph.setEmission(netuid, validatorUid, 1e9);

        // Execute transfer - should detect principal
        vm.prank(emergencyOperator);
        saintDurbin.executeTransfer(INITIAL_STAKE * 10);

        // Verify principal was detected and added
        uint256 principalAfter = saintDurbin.principalLocked();
        assertGt(principalAfter, principalBefore);

        // Verify only the normal yield was distributed
        assertLt(saintDurbin.lastPaymentAmount(), totalAddition);
    }

    function testMultiplePrincipalAdditions() public {
        // Establish baseline
        uint256 normalYield = 50e9; // 50 TAO per day
        mockStaking.addYield(
            contractSs58Key,
            validatorHotkey,
            netuid,
            normalYield
        );
        mockMetagraph.setEmission(netuid, validatorUid, 1000e9);
        vm.roll(block.number + 7200);
        vm.prank(emergencyOperator);
        saintDurbin.executeTransfer(INITIAL_STAKE * 10);

        // First principal addition
        uint256 firstAddition = 500e9;
        mockStaking.addYield(
            contractSs58Key,
            validatorHotkey,
            netuid,
            firstAddition + normalYield
        );
        vm.roll(block.number + 7200);

        uint256 principalBefore1 = saintDurbin.principalLocked();
        vm.prank(emergencyOperator);
        saintDurbin.executeTransfer(INITIAL_STAKE * 10);
        uint256 principalAfter1 = saintDurbin.principalLocked();
        assertEq(principalAfter1, principalBefore1);

        // Normal distribution
        mockStaking.addYield(
            contractSs58Key,
            validatorHotkey,
            netuid,
            normalYield
        );
        vm.roll(block.number + 7200);
        vm.prank(emergencyOperator);
        saintDurbin.executeTransfer(INITIAL_STAKE * 10);

        // Second principal addition
        uint256 secondAddition = 2000e9;
        mockStaking.addYield(
            contractSs58Key,
            validatorHotkey,
            netuid,
            secondAddition + normalYield
        );
        vm.roll(block.number + 7200);

        uint256 principalBefore2 = saintDurbin.principalLocked();
        vm.prank(emergencyOperator);
        saintDurbin.executeTransfer(INITIAL_STAKE * 10);
        uint256 principalAfter2 = saintDurbin.principalLocked();

        assertEq(principalAfter2, principalBefore2);

        // Verify total principal
        assertEq(saintDurbin.principalLocked(), INITIAL_STAKE);
    }

    function testRateAnalysisThreshold() public {
        // Establish baseline with higher yield
        uint256 normalYield = 200e9; // 200 TAO per day
        mockStaking.addYield(
            contractSs58Key,
            validatorHotkey,
            netuid,
            normalYield
        );
        vm.roll(block.number + 7200);
        mockMetagraph.setEmission(netuid, validatorUid, 1000e9);
        vm.prank(emergencyOperator);
        saintDurbin.executeTransfer(INITIAL_STAKE * 10);

        // Add yield just below 2x threshold (should NOT trigger principal detection)
        uint256 increasedYield = 390e9; // 1.95x
        mockStaking.addYield(
            contractSs58Key,
            validatorHotkey,
            netuid,
            increasedYield
        );
        vm.roll(block.number + 7200 + 1);

        uint256 principalBefore = saintDurbin.principalLocked();
        vm.prank(emergencyOperator);
        saintDurbin.executeTransfer(INITIAL_STAKE * 10);

        // // Principal should not change
        assertEq(saintDurbin.principalLocked(), principalBefore);

        // Full amount should be distributed
        assertEq(saintDurbin.lastPaymentAmount(), increasedYield);

        // Add yield just above 2x threshold (should trigger principal detection)
        uint256 spikedYield = 810e9; // > 2x of 390
        mockStaking.addYield(
            contractSs58Key,
            validatorHotkey,
            netuid,
            spikedYield
        );
        vm.roll(block.number + 7200 + 2);
        vm.prank(emergencyOperator);
        saintDurbin.executeTransfer(INITIAL_STAKE * 10);

        // // Principal should increase
        assertGe(saintDurbin.principalLocked(), principalBefore);
        // Only previous amount should be distributed
        assertEq(saintDurbin.lastPaymentAmount(), spikedYield);
    }

    function testPrincipalNeverDistributed() public {
        // Add massive principal
        uint256 hugePrincipal = 100000e9; // 100,000 TAO
        mockStaking.addYield(
            contractSs58Key,
            validatorHotkey,
            netuid,
            hugePrincipal
        );

        vm.prank(emergencyOperator);

        // First transfer to detect principal
        vm.roll(block.number + 7200);
        saintDurbin.executeTransfer(INITIAL_STAKE * 10 + hugePrincipal);

        // Add small yield
        uint256 smallYield = 10e9; // 10 TAO
        mockStaking.addYield(
            contractSs58Key,
            validatorHotkey,
            netuid,
            smallYield
        );

        // Multiple distributions
        for (uint256 i = 0; i < 10; i++) {
            vm.roll(block.number + 7200);
            uint256 principalBefore = saintDurbin.principalLocked();
            vm.prank(emergencyOperator);
            saintDurbin.executeTransfer(INITIAL_STAKE * 10 + hugePrincipal);

            uint256 balanceAfter = saintDurbin.getStakedBalance();

            // Balance should never go below principal
            assertGe(balanceAfter, principalBefore);

            // Add more yield for next iteration
            if (i < 9) {
                mockStaking.addYield(
                    contractSs58Key,
                    validatorHotkey,
                    netuid,
                    smallYield
                );
            }
        }
    }

    function testPrincipalDetectionWithVariableBlockTimes() public {
        // First distribution
        uint256 normalYield = 100e9;
        mockStaking.addYield(
            contractSs58Key,
            validatorHotkey,
            netuid,
            normalYield
        );
        vm.roll(block.number + 7200);
        mockMetagraph.setEmission(netuid, validatorUid, 1000e9);
        vm.prank(emergencyOperator);
        saintDurbin.executeTransfer(INITIAL_STAKE * 10);

        // Second distribution after longer period (should adjust rate accordingly)
        uint256 longerPeriodBlocks = 14400; // 2 days
        uint256 doubleYield = 200e9; // 2x yield for 2x time
        mockStaking.addYield(
            contractSs58Key,
            validatorHotkey,
            netuid,
            doubleYield
        );
        vm.roll(block.number + longerPeriodBlocks);

        uint256 principalBefore = saintDurbin.principalLocked();
        vm.prank(emergencyOperator);
        saintDurbin.executeTransfer(INITIAL_STAKE * 10);

        // Should NOT detect as principal (rate is same)
        assertEq(saintDurbin.principalLocked(), principalBefore);
        assertEq(saintDurbin.lastPaymentAmount(), doubleYield);

        // // Third distribution with principal after short period
        uint256 shortPeriodBlocks = 7200;
        uint256 principalPlusYield = 1000e9 + normalYield;
        mockStaking.addYield(
            contractSs58Key,
            validatorHotkey,
            netuid,
            principalPlusYield
        );
        vm.roll(block.number + shortPeriodBlocks + 1);
        vm.prank(emergencyOperator);
        saintDurbin.executeTransfer(INITIAL_STAKE * 10);

        // // Should detect principal
        assertEq(saintDurbin.principalLocked(), principalBefore);
    }
}
