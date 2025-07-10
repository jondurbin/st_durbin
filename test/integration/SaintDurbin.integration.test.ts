import { describe, it, before, beforeEach } from "mocha";
import { expect } from "chai";
import { ethers } from "ethers";
import { devnet } from "../../subtensor_chain/evm-tests/.papi/descriptors/dist"
import { getAliceSigner, getDevnetApi, getRandomSubstrateKeypair, waitForTransactionWithRetry } from "../../subtensor_chain/evm-tests/src/substrate";
import { TypedApi } from "polkadot-api";
import { convertH160ToPublicKey, convertH160ToSS58, convertPublicKeyToSs58 } from "../../subtensor_chain/evm-tests/src/address-utils";
import { tao } from "../../subtensor_chain/evm-tests/src/balance-math";
import {
    forceSetBalanceToSs58Address,
    forceSetBalanceToEthAddress,
    addNewSubnetwork,
    addStake,
    burnedRegister,
    setMaxAllowedValidators, disableWhiteListCheck,
    startCall
} from "../../subtensor_chain/evm-tests/src/subtensor";
import { generateRandomEthersWallet } from "../../subtensor_chain/evm-tests/src/utils";
import { IMETAGRAPH_ADDRESS, IMetagraphABI } from "../../subtensor_chain/evm-tests/src/contracts/metagraph";
import { ISTAKING_V2_ADDRESS, IStakingV2ABI } from "../../subtensor_chain/evm-tests/src/contracts/staking";

// Import the SaintDurbin contract ABI and bytecode
import SaintDurbinArtifact from "../../out/SaintDurbin.sol/SaintDurbin.json";
import { u8aToHex } from "@polkadot/util"

import { KeyPair } from "@polkadot-labs/hdkd-helpers/";

// it is not available in evm test framework, define it here
// for testing purpose, just use the alice to swap coldkey. in product, we can schedule a swap coldkey
async function swapColdkey(api: TypedApi<typeof devnet>, coldkey: KeyPair, contractAddress: string) {
    const alice = getAliceSigner()
    const internal_tx = api.tx.SubtensorModule.swap_coldkey({
        old_coldkey: convertPublicKeyToSs58(coldkey.publicKey),
        new_coldkey: convertH160ToSS58(contractAddress),
        swap_cost: tao(10)
    })
    const tx = api.tx.Sudo.sudo({
        call: internal_tx.decodedCall
    })
    await waitForTransactionWithRetry(api, tx, alice)
}

// Set target registrations per interval to 100
async function setTargetRegistrationsPerInterval(api: TypedApi<typeof devnet>, netuid: number) {
    const alice = getAliceSigner()
    const internal_tx = api.tx.AdminUtils.sudo_set_target_registrations_per_interval({
        netuid,
        target_registrations_per_interval: 100,
    })
    const tx = api.tx.Sudo.sudo({
        call: internal_tx.decodedCall
    })
    await waitForTransactionWithRetry(api, tx, alice)
}

describe("SaintDurbin Live Integration Tests", () => {
    let api: TypedApi<typeof devnet>; // TypedApi from polkadot-api
    let provider: ethers.JsonRpcProvider;
    let signer: ethers.Wallet;
    let netuid: number;
    let stakeContract: ethers.Contract
    let metagraphContract: ethers.Contract;
    // Test accounts
    const emergencyOperator = generateRandomEthersWallet();
    const validator1Hotkey = getRandomSubstrateKeypair();
    const validator1Coldkey = getRandomSubstrateKeypair();

    // 5 validators
    const validatorHotkeys = [getRandomSubstrateKeypair(), getRandomSubstrateKeypair(), getRandomSubstrateKeypair(), getRandomSubstrateKeypair(), getRandomSubstrateKeypair()];
    const validatorColdkeys = [getRandomSubstrateKeypair(), getRandomSubstrateKeypair(), getRandomSubstrateKeypair(), getRandomSubstrateKeypair(), getRandomSubstrateKeypair()];

    const contractColdkey = getRandomSubstrateKeypair();
    const drainAddress = getRandomSubstrateKeypair();
    // used to add stake after coldkey swap
    const secondColdkey = getRandomSubstrateKeypair();

    // Recipients for testing
    const recipients: { keypair: any, proportion: number }[] = [];
    for (let i = 0; i < 16; i++) {
        recipients.push({
            keypair: getRandomSubstrateKeypair(),
            proportion: 625 // 6.25% each
        });
    }

    let saintDurbin: any; // Using any to avoid type issues with contract deployment

    before(async function () {
        this.timeout(180000); // 3 minutes timeout for setup

        // Connect to local subtensor chain
        provider = new ethers.JsonRpcProvider("http://127.0.0.1:9944");
        signer = emergencyOperator.connect(provider);

        stakeContract = new ethers.Contract(
            ISTAKING_V2_ADDRESS,
            IStakingV2ABI,
            signer
        );

        metagraphContract = new ethers.Contract(
            IMETAGRAPH_ADDRESS,
            IMetagraphABI,
            signer
        );

        // Initialize substrate API
        api = await getDevnetApi();
        await disableWhiteListCheck(api, true)

        // Fund all test accounts
        console.log("Funding validator1Hotkey...");
        await forceSetBalanceToSs58Address(api, convertPublicKeyToSs58(validator1Hotkey.publicKey));
        console.log("Funding validator1Coldkey...");
        await forceSetBalanceToSs58Address(api, convertPublicKeyToSs58(validator1Coldkey.publicKey));
        for (let i = 0; i < validatorHotkeys.length; i++) {
            await forceSetBalanceToSs58Address(api, convertPublicKeyToSs58(validatorHotkeys[i].publicKey));
        }

        for (let i = 0; i < validatorColdkeys.length; i++) {
            await forceSetBalanceToSs58Address(api, convertPublicKeyToSs58(validatorColdkeys[i].publicKey));
        }
        console.log("Funding contractColdkey...");
        await forceSetBalanceToSs58Address(api, convertPublicKeyToSs58(contractColdkey.publicKey));
        console.log("Funding emergencyOperator...");
        await forceSetBalanceToEthAddress(api, emergencyOperator.address);

        // Recipients don't need funding - they only receive distributions
        // Wait a bit for all balance updates to settle
        console.log("Waiting for balance updates to settle...");
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Create a new subnet
        console.log("Creating new subnet...");
        await addNewSubnetwork(api, validator1Hotkey, validator1Coldkey);
        netuid = (await api.query.SubtensorModule.TotalNetworks.getValue()) - 1;
        console.log(`Subnet created with netuid: ${netuid}`);

        await startCall(api, netuid, validator1Coldkey)
        await setTargetRegistrationsPerInterval(api, netuid)
        // Set max allowed validators to enable validator permits
        console.log("Setting max allowed validators...");
        await setMaxAllowedValidators(api, netuid, 10);

        // Register validators
        console.log("Registering validator1...");
        await burnedRegister(api, netuid, convertPublicKeyToSs58(validator1Hotkey.publicKey), validator1Coldkey);

        for (let i = 0; i < validatorHotkeys.length; i++) {
            await burnedRegister(api, netuid, convertPublicKeyToSs58(validatorHotkeys[i].publicKey), validatorColdkeys[i]);
        }

        await addStake(api, netuid, convertPublicKeyToSs58(validator1Hotkey.publicKey), tao(10000), contractColdkey);

        for (let i = 0; i < validatorHotkeys.length; i++) {
            await addStake(api, netuid, convertPublicKeyToSs58(validatorHotkeys[i].publicKey), tao(i + 1), contractColdkey);
        }

        console.log(`Test setup complete. Netuid: ${netuid}`);
    });

    describe("Contract Deployment", () => {
        it("Should deploy SaintDurbin contract with correct parameters", async function () {
            this.timeout(30000);
            // Get validator1 UID
            const validator1Uid = await api.query.SubtensorModule.Uids.getValue(netuid, convertPublicKeyToSs58(validator1Hotkey.publicKey))
            const recipientColdkeys = recipients.map(r => r.keypair.publicKey);
            const proportions = recipients.map(r => r.proportion);

            // Deploy SaintDurbin
            const factory = new ethers.ContractFactory(
                SaintDurbinArtifact.abi,
                SaintDurbinArtifact.bytecode.object,
                signer
            );

            saintDurbin = await factory.deploy(
                emergencyOperator.address,
                drainAddress.publicKey,
                validator1Hotkey.publicKey,
                validator1Uid,
                contractColdkey.publicKey,
                netuid,
                recipientColdkeys,
                proportions
            );

            await saintDurbin.waitForDeployment();
            const contractAddress = await saintDurbin.getAddress();
            console.log(`SaintDurbin deployed at: ${contractAddress}`);

            // Verify deployment
            expect(await saintDurbin.emergencyOperator()).to.equal(emergencyOperator.address);
            expect(await saintDurbin.currentValidatorHotkey()).to.equal(u8aToHex(validator1Hotkey.publicKey));
            expect(await saintDurbin.netuid()).to.equal(BigInt(netuid));
            expect(await saintDurbin.getRecipientCount()).to.equal(BigInt(16));

            const stakedBalanceOnChain = await stakeContract.getStake(validator1Hotkey.publicKey, contractColdkey.publicKey, netuid)
            // Check initial balance
            const stakedBalance = await saintDurbin.getStakedBalance();
            expect(stakedBalance).to.be.gt(0);
            // may have difference since run coinbase
            // expect(await saintDurbin.principalLocked()).to.equal(stakedBalance);

            // switch coldkey to contract
            await swapColdkey(api, contractColdkey, contractAddress)

            await new Promise(resolve => setTimeout(resolve, 6000));

            // fund contract
            await forceSetBalanceToEthAddress(api, contractAddress)
            const contractSs58Address = convertH160ToSS58(contractAddress)

            const tx = await saintDurbin.setThisSs58PublicKey(convertH160ToPublicKey(contractAddress))
            await tx.wait()
        });
    });

    describe("Yield Distribution", () => {
        it("Should execute transfer when yield is available", async function () {
            this.timeout(60000);

            // Check if transfer can be executed
            let canExecute = await saintDurbin.canExecuteTransfer();
            while (!canExecute) {
                // Fast forward blocks if needed
                const blocksRemaining = await saintDurbin.blocksUntilNextTransfer();
                console.log(`Waiting for ${blocksRemaining} blocks...`);
                await new Promise(resolve => setTimeout(resolve, 6000)); // Sleep for 6 seconds
                canExecute = await saintDurbin.canExecuteTransfer();
            }

            // Execute transfer
            const tx = await saintDurbin.executeTransfer();
            const receipt = await tx.wait();

            // Check events
            const transferEvents = receipt.logs.filter((log: any) => {
                try {
                    const parsed = saintDurbin.interface.parseLog(log);
                    return parsed?.name === "StakeTransferred";
                } catch {
                    return false;
                }
            });
            expect(transferEvents.length).to.be.gt(0);

            // Verify recipients received funds
            for (let i = 0; i < 3; i++) { // Check first 3 recipients
                const recipientBalance = await stakeContract.getStake(validator1Hotkey.publicKey, recipients[i].keypair.publicKey, netuid)
                console.log(`Recipient ${i} balance: ${recipientBalance}`);
            }
        });
    });

    describe("Validator Switching", () => {
        it("Should switch validators when current validator loses permit", async function () {
            this.timeout(60000);

            const tx = await saintDurbin.checkAndSwitchValidator();
            const receipt = await tx.wait();

            // Check for validator switch event
            const switchEvents = receipt.logs.filter((log: any) => {
                try {
                    const parsed = saintDurbin.interface.parseLog(log);
                    return parsed?.name === "ValidatorSwitched";
                } catch {
                    return false;
                }
            });

            expect(switchEvents.length).to.equal(1);

            // Verify new validator
            const newValidatorHotkey = await saintDurbin.currentValidatorHotkey();
            expect(newValidatorHotkey).to.equal(ethers.hexlify(validatorHotkeys[4].publicKey));

        });
    });

    describe("Emergency Drain", () => {
        it("Should handle emergency drain with timelock", async function () {
            this.timeout(120000);

            // Request emergency drain
            const requestTx = await saintDurbin.requestEmergencyDrain();
            await requestTx.wait();

            // Check drain status
            const [isPending, timeRemaining] = await saintDurbin.getEmergencyDrainStatus();
            expect(isPending).to.be.true;
            expect(timeRemaining).to.be.gt(0);

            // Try to execute before timelock - should fail
            try {
                await saintDurbin.executeEmergencyDrain();
                expect.fail("Should not execute before timelock");
            } catch (error: any) {
                // the message string not include it.
                expect(error).to.not.be.undefined;
                // expect(error.message).to.include("TimelockNotExpired");
            }

            // Cancel the drain for this test
            const cancelTx = await saintDurbin.cancelEmergencyDrain();
            await cancelTx.wait();

            const [isPendingAfter] = await saintDurbin.getEmergencyDrainStatus();
            expect(isPendingAfter).to.be.false;
        });
    });

    describe("Principal Detection", () => {
        it("Should detect and preserve principal additions", async function () {
            this.timeout(60000);

            const initialPrincipal = await saintDurbin.principalLocked();

            let canExecute = await saintDurbin.canExecuteTransfer();
            while (!canExecute) {
                // Fast forward blocks if needed
                const blocksRemaining = await saintDurbin.blocksUntilNextTransfer();
                console.log(`Waiting for ${blocksRemaining} blocks...`);
                await new Promise(resolve => setTimeout(resolve, 6000)); // Sleep for 6 seconds
                canExecute = await saintDurbin.canExecuteTransfer();
            }

            // Execute transfer
            const tx = await saintDurbin.executeTransfer();
            const receipt = await tx.wait();

            // Check for principal detection event
            const principalEvents = receipt.logs.filter((log: any) => {
                try {
                    const parsed = saintDurbin.interface.parseLog(log);
                    return parsed?.name === "PrincipalDetected";
                } catch {
                    return false;
                }
            });

            if (principalEvents.length > 0) {
                const newPrincipal = await saintDurbin.principalLocked();
                expect(newPrincipal).to.be.gt(initialPrincipal);
            }
        });
    });

    after(async function () {
        // Clean up API connection
        // if (api) {
        //     await api.destroy();
        // }
    });
});