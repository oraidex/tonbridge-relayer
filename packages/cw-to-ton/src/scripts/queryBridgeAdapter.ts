import { CosmWasmClient } from "@cosmjs/cosmwasm-stargate";
import { QueryClient } from "@cosmjs/stargate";
import { Tendermint37Client } from "@cosmjs/tendermint-rpc";
import { parseWasmEvents } from "@oraichain/oraidex-common";
import {
  BridgeAdapter,
  getExistenceProofSnakeCell,
  getPacketProofs,
} from "@oraichain/ton-bridge-contracts";
import { Network } from "@orbs-network/ton-access";
import { TransferPacket } from "../dtos/packets/TransferPacket";
import { BRIDGE_WASM_ACTION } from "../services";
import { createTonWallet, waitSeqno } from "../utils";
import { Address, toNano, TupleItemCell } from "@ton/core";
import { ExistenceProof } from "cosmjs-types/cosmos/ics23/v1/proofs";
import * as dotenv from "dotenv";
dotenv.config();
const argv = process.argv.slice(2);
const provenHeight = parseInt(argv[0]);
const packetTx = argv[1];

(async () => {
  const needProvenHeight = provenHeight + 1;
  const { client, walletContract, key } = await createTonWallet(
    process.env.TON_MNEMONIC!,
    process.env.NODE_ENV as Network
  );
  const bridgeAdapter = BridgeAdapter.createFromAddress(
    Address.parse(process.env.TON_BRIDGE!)
  );
  const bridgeAdapterContract = client.open(bridgeAdapter);
  const data = await bridgeAdapterContract.getBridgeData();
  const lightClientMaster = (data.pop() as TupleItemCell).cell;
  console.log(lightClientMaster.beginParse().loadAddress());
})();
