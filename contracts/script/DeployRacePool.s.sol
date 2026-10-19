// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {RacePool} from "../src/RacePool.sol";

/// @notice RacePool'u deploy eder.
/// .env (contracts/): PRIVATE_KEY (deploy eden), RESULT_SIGNER (sunucunun imza ADRESİ, anahtarı değil),
///                    TREASURY (isteğe bağlı; yoksa deploy eden adres)
/// Çalıştırma: forge script script/DeployRacePool.s.sol --rpc-url monad_testnet --broadcast
contract DeployRacePool is Script {
    function run() external returns (RacePool pool) {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address signer = vm.envAddress("RESULT_SIGNER");
        address treasury = vm.envOr("TREASURY", vm.addr(deployerKey));

        vm.startBroadcast(deployerKey);
        pool = new RacePool(signer, treasury);
        vm.stopBroadcast();

        console.log("RacePool adresi:", address(pool));
        console.log("resultSigner:", signer);
        console.log("treasury:", treasury);
    }
}
