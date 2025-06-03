import { CosmWasmClient } from "@cosmjs/cosmwasm-stargate";
import { QueryClient } from "@cosmjs/stargate";
import { Tendermint37Client } from "@cosmjs/tendermint-rpc";
import { parseWasmEvents } from "@oraichain/oraidex-common";
import {
  BridgeAdapter,
  getAckPacketProofs,
  getExistenceProofSnakeCell,
} from "@oraichain/ton-bridge-contracts";
import { Network } from "@orbs-network/ton-access";
import { TransferPacket } from "../dtos/packets/TransferPacket";
import { BRIDGE_WASM_ACTION } from "../services";
import { createTonWallet, waitSeqno } from "../utils";
import { Address, toNano } from "@ton/core";
import { ExistenceProof } from "cosmjs-types/cosmos/ics23/v1/proofs";
import * as dotenv from "dotenv";
import { AckPacket } from "@src/dtos/packets/AckPacket";
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
  console.log(await bridgeAdapterContract.getBridgeData());
  // process.env.COSMOS_RPC_URL!
  const cosmwasmClient = await CosmWasmClient.connect(
    "http://3.14.142.99:26657"
  );
  console.log(packetTx);
  const tx = await cosmwasmClient.getTx(packetTx);
  console.log(tx);
  const wasmAttr = parseWasmEvents(tx!.events);
  const filterByContractAddress = (attr: Record<string, string>) =>
    attr["_contract_address"] === process.env.WASM_BRIDGE;
  // This action come from user need to normalize and submit by relayer.
  const sendToTonEvents = wasmAttr
    .filter(filterByContractAddress)
    .filter((attr) => attr["action"] === BRIDGE_WASM_ACTION.SEND_TO_COSMOS);
  const packetEvent = sendToTonEvents[0];
  const ackPacket = AckPacket.fromRawAttributes(packetEvent);
  const tendermint37 = await Tendermint37Client.connect(
    process.env.COSMOS_RPC_URL as string
  );
  const queryClient = new QueryClient(tendermint37 as any);
  const packetProofs = await getAckPacketProofs(
    queryClient,
    process.env.WASM_BRIDGE as string,
    provenHeight,
    BigInt(packetEvent["seq"])
  );
  const proofs = packetProofs.map((proof) => {
    return ExistenceProof.fromJSON(proof);
  });

  await bridgeAdapterContract.sendBridgeRecvPacket(
    walletContract.sender(key.secretKey),
    {
      provenHeight: needProvenHeight,
      packet: ackPacket.intoCell(),
      proofs: getExistenceProofSnakeCell(proofs as any)!,
    },
    { value: toNano("0.7") }
  );
  await waitSeqno(walletContract, await walletContract.getSeqno(), 15);
})();
