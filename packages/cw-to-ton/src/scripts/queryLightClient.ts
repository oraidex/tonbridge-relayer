import { CosmWasmClient } from "@cosmjs/cosmwasm-stargate";
import { QueryClient } from "@cosmjs/stargate";
import { Tendermint37Client } from "@cosmjs/tendermint-rpc";
import { parseWasmEvents } from "@oraichain/oraidex-common";
import {
  BridgeAdapter,
  getExistenceProofSnakeCell,
  getPacketProofs,
  LightClientMaster,
} from "@oraichain/ton-bridge-contracts";
import { Network } from "@orbs-network/ton-access";
import { TransferPacket } from "../dtos/packets/TransferPacket";
import { BRIDGE_WASM_ACTION } from "../services";
import { createTonWallet, waitSeqno } from "../utils";
import { Address, toNano } from "@ton/core";
import { ExistenceProof } from "cosmjs-types/cosmos/ics23/v1/proofs";
import * as dotenv from "dotenv";
dotenv.config();

(async () => {
  const { client, walletContract, key } = await createTonWallet(
    process.env.TON_MNEMONIC!,
    process.env.NODE_ENV as Network
  );
  const lightClientMaster = LightClientMaster.createFromAddress(
    Address.parse(process.env.COSMOS_LIGHT_CLIENT_MASTER!)
  );
  const lightClientMasterContract = client.open(lightClientMaster);
  const cosmwasmClient = await CosmWasmClient.connect(
    process.env.COSMOS_RPC_URL!
  );

  console.log("Height", await lightClientMasterContract.getTrustedHeight());
})();
