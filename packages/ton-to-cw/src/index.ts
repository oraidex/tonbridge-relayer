import {
  LiteClient,
  LiteEngine,
  LiteRoundRobinEngine,
  LiteSingleEngine,
} from "ton-lite-client";
import TonBlockProcessor from "./block-processor";
import { initSignClient } from "./client";
import { Config } from "./config";
import TonTxProcessor from "./tx-processor";
import { setTimeout } from "timers/promises";
import { intToIP } from "./constants";
import TonWeb from "tonweb";
import {
  TonbridgeBridgeClient,
  TonbridgeValidatorClient,
} from "@oraichain/tonbridge-contracts-sdk";
import { Logger } from "winston";
import { liteServer_BlockData } from "ton-lite-client/dist/schema";
import { ParsedBlock } from "@oraichain/tonbridge-utils";

export default class TonToCwRelayer {
  private blockProcessor: TonBlockProcessor;
  private txProcessor: TonTxProcessor;
  private logger: Logger;

  withBlockProcessor(processor: TonBlockProcessor) {
    this.blockProcessor = processor;
    return this;
  }

  withTxProcessor(processor: TonTxProcessor) {
    this.txProcessor = processor;
    return this;
  }
  withLogger(logger: Logger) {
    this.logger = logger;
    return this;
  }

  async relay() {
    const processInterval = 3000; // 3s
    if (!this.blockProcessor || !this.txProcessor)
      throw new Error("block and tx processors are not initialized yet");

    while (true) {
      try {
        const latestMasterchainBlock = await this.getMasterchainInfo();
        const { rawBlockData, parsedBlock } = await this.queryKeyBlock(
          latestMasterchainBlock.last.seqno
        );
        this.logger.info("Masterchain: " + latestMasterchainBlock.last.seqno);
        this.logger.info("Keyblock: " + parsedBlock.info.seq_no);
        await this.verifyMasterchainKeyBlock(rawBlockData);
        await this.txProcessor.processTransactions(latestMasterchainBlock.last);
      } catch (error) {
        // do nothing since we already catch the error in individual methods
        this.logger.error("error processing block and tx: " + error);
      }
      await setTimeout(processInterval);
    }
  }

  private async getMasterchainInfo() {
    try {
      return await this.blockProcessor.getMasterchainInfo();
    } catch (error) {
      this.logger.error("error getting masterchain info: " + error);
      throw error;
    }
  }

  private async queryKeyBlock(masterChainSeqNo: number) {
    try {
      return await this.blockProcessor.queryKeyBlock(masterChainSeqNo);
    } catch (error) {
      this.logger.error("error queryKeyBlock: " + error);
      throw error;
    }
  }

  private async verifyMasterchainKeyBlock(rawBlockData: liteServer_BlockData) {
    try {
      return await this.blockProcessor.verifyMasterchainKeyBlock(rawBlockData);
    } catch (error) {
      this.logger.error("Error verifyMasterchainKeyBlock: " + error);
      throw error;
    }
  }
}

export async function createTonToCwRelayerWithConfig(
  config: Config,
  injectedLogger: Logger
) {
  const client = await initSignClient(config.mnemonic);
  // setup lite engine server
  const { liteservers } = await fetch(
    "https://ton.org/global.config.json"
  ).then((data) => data.json());
  const engines: LiteEngine[] = [];
  engines.push(
    ...liteservers.map(
      (server: any) =>
        new LiteSingleEngine({
          host: `tcp://${intToIP(server.ip)}:${server.port}`,
          publicKey: Buffer.from(server.id.key, "base64"),
        })
    )
  );
  const liteEngine = new LiteRoundRobinEngine(engines);
  const liteClient = new LiteClient({ engine: liteEngine });

  // should host a private ton http api in production: https://github.com/toncenter/ton-http-api
  const tonWeb = new TonWeb(
    new TonWeb.HttpProvider(config.tonHttpApiURL, { apiKey: config.tonApiKey })
  );

  const validator = new TonbridgeValidatorClient(
    client.client,
    client.sender,
    config.cwTonValidators
  );
  const bridge = new TonbridgeBridgeClient(
    client.client,
    client.sender,
    config.cwTonBridge
  );

  const blockProcessor = new TonBlockProcessor(
    validator,
    liteClient,
    tonWeb,
    injectedLogger
  );
  const txProcessor = new TonTxProcessor(
    validator,
    bridge,
    liteClient,
    blockProcessor,
    config.jettonBridge,
    injectedLogger
  );

  const relayer = new TonToCwRelayer()
    .withLogger(injectedLogger)
    .withBlockProcessor(blockProcessor)
    .withTxProcessor(txProcessor);

  return relayer;
}

export type { Config } from "./config";
