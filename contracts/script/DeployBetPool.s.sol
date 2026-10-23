// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {BetPool, IRacePool} from "../src/BetPool.sol";

/// @notice BetPool'u deploy eder. Önce RacePool deploy edilmiş olmalı (bahisler RacePool odalarına bağlı).
/// .env (contracts/): PRIVATE_KEY (deploy eden), RACE_POOL (RacePool adresi),
///                    RESULT_SIGNER (sunucunun imza ADRESİ: bahisleri açar ve kazananı imzalar)
/// Çalıştırma: forge script script/DeployBetPool.s.sol --rpc-url monad_testnet --broadcast
contract DeployBetPool is Script {
    function run() external returns (BetPool bets) {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address racePool = vm.envAddress("RACE_POOL");
        address signer = vm.envAddress("RESULT_SIGNER");
        require(racePool.code.length > 0, "RACE_POOL adresinde kontrat yok");

        vm.startBroadcast(deployerKey);
        bets = new BetPool(IRacePool(racePool), signer);
        vm.stopBroadcast();

        console.log("BetPool adresi:", address(bets));
        console.log("RacePool:", racePool);
        console.log("resultSigner (operator):", signer);
    }
}
