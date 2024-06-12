import { SimulateCosmWasmClient } from "@oraichain/cw-simulate";
import { toAmount } from "@oraichain/oraidex-common";
import { OraiswapTokenClient } from "@oraichain/oraidex-contracts-sdk";
import {
  InstantiateMsg as Cw20InstantiateMsg,
  MinterResponse,
} from "@oraichain/oraidex-contracts-sdk/build/OraiswapToken.types";
import { deployContract } from "@oraichain/tonbridge-contracts-build";
import {
  TonbridgeBridgeClient,
  TonbridgeValidatorClient,
} from "@oraichain/tonbridge-contracts-sdk";
import { ValidatorSignature } from "@oraichain/tonbridge-utils";
import { Address } from "@ton/core";
import {
  LiteClient,
  LiteEngine,
  LiteRoundRobinEngine,
  LiteSingleEngine,
} from "ton-lite-client";
import {
  Functions,
  liteServer_masterchainInfoExt,
} from "ton-lite-client/dist/schema";
import TonWeb from "tonweb";
import TonBlockProcessor from "./src/block-processor";
import { relay } from "./src/index";

export function intToIP(int: number) {
  var part1 = int & 255;
  var part2 = (int >> 8) & 255;
  var part3 = (int >> 16) & 255;
  var part4 = (int >> 24) & 255;

  return part4 + "." + part3 + "." + part2 + "." + part1;
}

(async () => {
  const client = new SimulateCosmWasmClient({
    chainId: "Oraichain",
    bech32Prefix: "orai",
    metering: true,
  });
  const sender = "orai12zyu8w93h0q2lcnt50g3fn0w3yqnhy4fvawaqz";

  // setup lite engine server
  const { liteservers } = await fetch(
    "https://ton.org/global.config.json"
  ).then((data) => data.json());
  // Personal choice. Can choose a different index if needed
  const server = liteservers[2];

  const engines: LiteEngine[] = [];
  engines.push(
    new LiteSingleEngine({
      host: `tcp://${intToIP(server.ip)}:${server.port}`,
      publicKey: Buffer.from(server.id.key, "base64"),
    })
  );
  const liteEngine = new LiteRoundRobinEngine(engines);
  const liteClient = new LiteClient({ engine: liteEngine });
  const tonWeb = new TonWeb(
    new TonWeb.HttpProvider(undefined, {
      apiKey: process.env.TONCENTER_API_KEY,
    })
  );

  const masterchainInfo = await liteClient.getMasterchainInfoExt();
  const { rawBlockData } = await TonBlockProcessor.queryKeyBlock(
    masterchainInfo.last.seqno,
    liteClient
  );
  let initialKeyBlockBoc = rawBlockData.data.toString("hex");

  // deploy contracts
  const validatorDeployResult = await deployContract(
    client,
    sender,
    { boc: initialKeyBlockBoc },
    "bridge-validator",
    "cw-tonbridge-validator"
  );
  const bridgeDeployResult = await deployContract(
    client,
    sender,
    {},
    "bridge-bridge",
    "cw-tonbridge-bridge"
  );
  const dummyTokenDeployResult = await deployContract(
    client,
    sender,
    {
      decimals: 6,
      initial_balances: [
        { address: sender, amount: toAmount(10000).toString() },
      ],
      name: "Dummy Token",
      symbol: "DUMMY",
      mint: {
        minter: bridgeDeployResult.contractAddress,
      } as MinterResponse,
    } as Cw20InstantiateMsg,
    "dummy-token",
    "oraiswap-token"
  );

  const validator = new TonbridgeValidatorClient(
    client,
    sender,
    validatorDeployResult.contractAddress
  );
  const bridge = new TonbridgeBridgeClient(
    client,
    sender,
    bridgeDeployResult.contractAddress
  );
  const dummyToken = new OraiswapTokenClient(
    client,
    sender,
    dummyTokenDeployResult.contractAddress
  );

  // FIXME: change denom & channel id to correct denom and channel id
  await bridge.updateMappingPair({
    denom: "",
    localAssetInfo: { token: { contract_addr: dummyToken.contractAddress } },
    localChannelId: "",
    localAssetInfoDecimals: 6,
    remoteDecimals: 6,
  });

  relay({
    validator,
    bridge,
    tonweb: tonWeb,
    liteClient,
    jettonBridgeAddress: "EQD-YRkuEQs7grDLTMQ1MdYxRmwTTAVsdiY1g1C7O2AfeMgN",
  });
})();