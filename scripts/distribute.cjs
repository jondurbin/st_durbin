// scripts/distribute.js
const { ethers } = require('ethers');

// Only load dotenv if not in test environment
if (process.env.NODE_ENV !== 'test') {
  require('dotenv').config();
}

const SAINTDURBIN_ABI = [
  "function canExecuteTransfer() external view returns (bool)",
  "function executeTransfer() external",
  "function getNextTransferAmount() external view returns (uint256)",
  "function blocksUntilNextTransfer() external view returns (uint256)",
  "function getAvailableRewards() external view returns (uint256)",
  "function currentValidatorHotkey() external view returns (bytes32)",
  "function currentValidatorUid() external view returns (uint16)",
  "function getCurrentValidatorInfo() external view returns (bytes32 hotkey, uint16 uid, bool isValid)",
  "function getStakedBalance() external view returns (uint256)",
  "function checkAndSwitchValidator() external",
  "function principalLocked() external view returns (uint256)",
  "function lastTransferBlock() external view returns (uint256)",
  "event ValidatorSwitched(bytes32 indexed oldHotkey, bytes32 indexed newHotkey, uint16 newUid, string reason)",
  "event StakeTransferred(uint256 totalAmount, uint256 newBalance)"
];

// Configuration for monitoring
const CONFIG = {
  // Check validator status every N distributions
  checkInterval: parseInt(process.env.VALIDATOR_CHECK_INTERVAL || '10'),

  // Monitor for validator switches
  monitorValidatorSwitches: true
};

let distributionCount = 0;

/**
 * Get current distribution count
 * @returns {number} Current distribution count
 */
function getDistributionCount() {
  return distributionCount;
}

/**
 * Set distribution count (useful for testing)
 * @param {number} count - New distribution count
 */
function setDistributionCount(count) {
  distributionCount = count;
}

/**
 * Execute a distribution
 * @param {Object} params - Parameters object
 * @param {ethers.providers.Provider} params.provider - The Ethereum provider
 * @param {ethers.Signer} params.signer - The signer
 * @param {ethers.Contract} params.contract - The SaintDurbin contract instance
 * @param {boolean} params.skipValidatorCheck - Skip validator status check
 * @returns {Object} Result object with success status and details
 */
async function executeDistribution(params) {
  const { provider, signer, contract, skipValidatorCheck = false } = params;

  const result = {
    success: false,
    canExecute: false,
    blocksRemaining: null,
    txHash: null,
    amount: null,
    gasUsed: null,
    error: null,
    validatorSwitched: false,
    validatorStatus: null
  };

  try {
    // Increment distribution counter
    distributionCount++;

    // Check validator status periodically
    if (!skipValidatorCheck && distributionCount % CONFIG.checkInterval === 0) {
      result.validatorStatus = await checkValidatorStatus({ contract });
    }

    // Check if distribution can be executed
    result.canExecute = await contract.canExecuteTransfer();

    if (!result.canExecute) {
      result.blocksRemaining = await contract.blocksUntilNextTransfer();
      result.error = `Cannot execute transfer yet. ${result.blocksRemaining} blocks remaining`;
      console.log(result.error);
      return result;
    }

    // Get distribution details
    const nextAmount = await contract.getNextTransferAmount();
    const availableRewards = await contract.getAvailableRewards();

    console.log('Next transfer amount:', ethers.formatUnits(nextAmount, 9), 'TAO');
    console.log('Available rewards:', ethers.formatUnits(availableRewards, 9), 'TAO');

    // Execute the transfer
    console.log('Executing transfer...');
    const tx = await contract.executeTransfer({
      gasLimit: 1000000 // Adjust based on testing
    });

    console.log('Transaction submitted:', tx.hash);
    const receipt = await tx.wait();

    if (receipt.status === 1) {
      result.success = true;
      result.txHash = tx.hash;
      result.amount = ethers.formatUnits(nextAmount, 9);
      result.gasUsed = receipt.gasUsed.toString();

      const message = `✅ Distribution successful!\nTx: ${tx.hash}\nAmount: ${ethers.formatUnits(nextAmount, 9)} TAO\nGas used: ${receipt.gasUsed.toString()}`;
      console.log(message);

      // Monitor for validator switches during distribution
      if (CONFIG.monitorValidatorSwitches) {
        const switchEvents = await monitorValidatorSwitches({
          contract,
          provider,
          fromBlock: receipt.blockNumber,
          toBlock: receipt.blockNumber
        });
        result.validatorSwitched = switchEvents.length > 0;
      }
    } else {
      throw new Error('Transaction failed');
    }

  } catch (error) {
    result.error = error.message;
    const message = `❌ Distribution failed!\nError: ${error.message}`;
    console.error(message);
  }

  return result;
}

/**
 * Initialize distribution components
 * @param {Object} config - Configuration object
 * @param {string} config.rpcUrl - RPC URL
 * @param {string} config.privateKey - Private key
 * @param {string} config.contractAddress - Contract address
 * @returns {Object} Object with provider, wallet, and contract
 */
function initializeDistribution(config) {
  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  const wallet = new ethers.Wallet(config.privateKey, provider);
  const contract = new ethers.Contract(config.contractAddress, SAINTDURBIN_ABI, wallet);

  return { provider, wallet, contract };
}

/**
 * Check validator status
 * @param {Object} params - Parameters
 * @param {ethers.Contract} params.contract - The SaintDurbin contract instance
 * @returns {Object} Status object with validator information
 */
async function checkValidatorStatus(params) {
  const { contract } = params;
  console.log('Checking validator status...');

  const status = {
    success: false,
    hotkey: null,
    uid: null,
    isValid: false,
    invalidReason: null,
    stakedBalance: null,
    validatorSwitched: false,
    switchTransactionHash: null,
    error: null
  };

  try {
    // Get current validator info
    const validatorInfo = await contract.getCurrentValidatorInfo();
    status.hotkey = validatorInfo.hotkey;
    status.uid = Number(validatorInfo.uid);
    status.isValid = validatorInfo.isValid;

    console.log('Current validator:');
    console.log('  Hotkey:', status.hotkey);
    console.log('  UID:', status.uid);
    console.log('  Is valid:', status.isValid);

    if (!status.isValid) {
      status.invalidReason = 'Validator is not active on the metagraph';
      const message = `⚠️ Current validator is no longer valid!\nThe contract will automatically switch to a new validator.\nHotkey: ${status.hotkey}\nUID: ${status.uid}`;
      console.warn(message);
    } else {
      console.log('Validator status check passed');
    }

    // Also check contract's staked balance
    const stakedBalance = await contract.getStakedBalance();
    status.stakedBalance = stakedBalance.toString();
    console.log('Contract staked balance:', ethers.formatUnits(stakedBalance, 9), 'TAO');

    status.success = true;
  } catch (error) {
    status.error = 'Failed to check validator status';
    const message = `❌ Validator status check failed!\nError: ${error.message}`;
    console.error(message);
  }

  return status;
}

/**
 * Monitor for validator switch events
 * @param {Object} params - Parameters
 * @param {ethers.Contract} params.contract - The SaintDurbin contract instance
 * @param {ethers.providers.Provider} params.provider - The Ethereum provider
 * @param {number} params.fromBlock - Starting block
 * @param {number} params.toBlock - Ending block (optional)
 * @returns {Array} Array of switch events
 */
async function monitorValidatorSwitches(params) {
  const { contract, provider, fromBlock, toBlock } = params;
  const switchEvents = [];

  try {
    const endBlock = toBlock || await provider.getBlockNumber();
    const filter = contract.filters.ValidatorSwitched();
    const events = await contract.queryFilter(filter, fromBlock, endBlock);

    for (const event of events) {
      const eventData = {
        blockNumber: event.blockNumber,
        oldHotkey: event.args.oldHotkey,
        newHotkey: event.args.newHotkey,
        oldUid: Number(event.args.oldUid || 0),
        newUid: Number(event.args.newUid),
        reason: event.args.reason,
        timestamp: null
      };

      // Get block timestamp
      try {
        const block = await event.getBlock();
        eventData.timestamp = block.timestamp;
      } catch (err) {
        console.error('Failed to get block timestamp:', err.message);
      }

      switchEvents.push(eventData);

      const message = `🔄 Validator switched!\nOld: ${eventData.oldHotkey}\nNew: ${eventData.newHotkey}\nNew UID: ${eventData.newUid}\nReason: ${eventData.reason}`;
      console.log(message);
    }
  } catch (error) {
    console.error('Error monitoring validator switches:', error.message);
  }

  return switchEvents;
}

/**
 * Main function for CLI execution
 */
async function main() {
  console.log('SaintDurbin Distribution Script Started');
  console.log('Contract:', process.env.CONTRACT_ADDRESS);

  try {
    const { provider, wallet, contract } = initializeDistribution({
      rpcUrl: process.env.RPC_URL,
      privateKey: process.env.PRIVATE_KEY,
      contractAddress: process.env.CONTRACT_ADDRESS
    });

    console.log('Executor:', wallet.address);

    const result = await executeDistribution({ contract, provider, signer: wallet });

    if (!result.success && result.error) {
      process.exit(1);
    }
  } catch (error) {
    console.error('Failed to initialize distribution:', error.message);
    process.exit(1);
  }
}

// Export functions for testing
module.exports = {
  SAINTDURBIN_ABI,
  CONFIG,
  initializeDistribution,
  executeDistribution,
  checkValidatorStatus,
  monitorValidatorSwitches,
  getDistributionCount,
  setDistributionCount,
  main
};

// Run main function if this file is executed directly
if (require.main === module) {
  main().catch((error) => {
    console.error('Unhandled error:', error);
    process.exit(1);
  });
}
