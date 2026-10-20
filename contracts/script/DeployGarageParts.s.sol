// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {GarageParts} from "../src/GarageParts.sol";

/// @notice GarageParts'ı deploy eder ve kataloğu shared/parts.json'dan tanımlar.
/// Oyun ve sunucu da aynı dosyayı okur → oyunun gösterdiği fiyat ile kontratın istediği fiyat hep aynı.
/// Her slotun JSON'daki ilk parçası o slotun ücretsiz varsayılanı olur (sıra önemli).
/// Çalıştırma: forge script script/DeployGarageParts.s.sol --rpc-url monad_testnet --broadcast
contract DeployGarageParts is Script {
    function run() external returns (GarageParts garage) {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/../shared/parts.json"));

        vm.startBroadcast(deployerKey);
        garage = new GarageParts(deployer); // owner = deploy eden (katalog ve satış geliri)
        uint256 count = 0;
        for (uint256 i = 0;; i++) {
            string memory key = string.concat(".parts[", vm.toString(i), "]");
            if (!vm.keyExistsJson(json, key)) break; // dizinin sonu
            uint256 id = vm.parseJsonUint(json, string.concat(key, ".id"));
            uint256 slot = vm.parseJsonUint(json, string.concat(key, ".slot"));
            uint256 price = vm.parseJsonUint(json, string.concat(key, ".priceWei")); // "20000000000000000" gibi yazı
            garage.definePart(id, uint8(slot), price);
            count++;
        }
        vm.stopBroadcast();

        console.log("GarageParts adresi:", address(garage));
        console.log("owner:", deployer);
        console.log("tanimlanan parca:", count);
    }
}
