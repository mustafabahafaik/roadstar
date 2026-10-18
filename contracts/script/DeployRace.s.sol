// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {Race} from "../src/Race.sol";

/// @notice Race'i deploy eder (Race, kendi RaceItems token kontratını constructor'da oluşturur).
/// Çalıştırma: forge script script/DeployRace.s.sol --rpc-url monad_testnet --broadcast
contract DeployRace is Script {
    function run() external returns (Race race) {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY"); // .env'den (Foundry otomatik yükler)

        // startBroadcast ile stopBroadcast arasındaki çağrılar gerçek işlem olarak zincire gönderilir
        vm.startBroadcast(deployerKey);
        race = new Race();
        vm.stopBroadcast();

        console.log("Race adresi:", address(race));
        console.log("RaceItems adresi:", address(race.items()));
    }
}
