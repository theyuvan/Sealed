// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {MandateRegistry} from "../src/MandateRegistry.sol";
import {SessionEscrow, ISpendVerifier} from "../src/SessionEscrow.sol";
import {SpendVerifier} from "../src/SpendVerifier.sol";
import {DevEIP3009Token} from "../src/dev/DevEIP3009Token.sol";

/// Deploys SpendVerifier, MandateRegistry, SessionEscrow (+ Poseidon libraries via linking) and writes
/// deployments/<chainid>.json. Run through scripts/deploy.mjs, which asks before mainnet.
///
/// env: DEPLOYER_PRIVATE_KEY, COORDINATOR_ADDRESS, PINNED_TOKEN (required on 177),
///      ESCROW_OWNER (optional, defaults to deployer), CONFIRM_MAINNET=yes (required on 177)
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address coordinator = vm.envAddress("COORDINATOR_ADDRESS");
        address owner = vm.envOr("ESCROW_OWNER", deployer);
        address token = vm.envOr("PINNED_TOKEN", address(0));

        if (block.chainid == 177) {
            require(token != address(0), "PINNED_TOKEN is required on mainnet");
            require(keccak256(bytes(vm.envOr("CONFIRM_MAINNET", string("")))) == keccak256("yes"), "set CONFIRM_MAINNET=yes");
        }

        vm.startBroadcast(pk);
        if (token == address(0)) {
            token = address(new DevEIP3009Token());
            console2.log("deployed DEV token (not for production):", token);
        }
        SpendVerifier verifier = new SpendVerifier();
        MandateRegistry registry = new MandateRegistry();
        SessionEscrow escrow = new SessionEscrow(ISpendVerifier(address(verifier)), registry, coordinator, deployer);
        registry.setEscrow(address(escrow));
        escrow.setTokenAllowed(token, true);
        if (owner != deployer) escrow.transferOwnership(owner);
        vm.stopBroadcast();

        string memory k = "deployment";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeAddress(k, "registry", address(registry));
        vm.serializeAddress(k, "escrow", address(escrow));
        vm.serializeAddress(k, "verifier", address(verifier));
        vm.serializeAddress(k, "token", token);
        vm.serializeAddress(k, "coordinator", coordinator);
        string memory json = vm.serializeUint(k, "deployBlock", block.number);
        string memory path = vm.envOr("DEPLOYMENT_FILE", string.concat("deployments/", vm.toString(block.chainid), ".json"));
        vm.writeJson(json, path);

        console2.log("registry", address(registry));
        console2.log("escrow  ", address(escrow));
        console2.log("verifier", address(verifier));
        console2.log("token   ", token);
        console2.log("wrote", path);
    }
}
