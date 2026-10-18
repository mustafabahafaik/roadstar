// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {RaceItems} from "../src/RaceItems.sol";

/// @notice RaceItems'ı deploy eder.
/// Çalıştırma: forge script script/DeployRaceItems.s.sol --rpc-url monad_testnet --broadcast
contract DeployRaceItems is Script {
    function run() external returns (RaceItems items) {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY"); // .env'den (Foundry otomatik yükler)

        // startBroadcast ile stopBroadcast arasındaki çağrılar gerçek işlem olarak zincire gönderilir
        vm.startBroadcast(deployerKey);
        items = new RaceItems();
        vm.stopBroadcast();

        console.log("RaceItems adresi:", address(items));
    }
}
