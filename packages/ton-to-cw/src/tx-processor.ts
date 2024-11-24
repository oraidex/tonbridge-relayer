import {
  TonbridgeBridgeInterface,
  TonbridgeValidatorInterface,
} from "@oraichain/tonbridge-contracts-sdk";
import { Cell, address, loadTransaction } from "@ton/core";
import { StringHex, TransactionWithBlockId } from "../src/@types/block";
import { LiteClient } from "ton-lite-client";
import TonBlockProcessor from "./block-processor";
import { setTimeout } from "timers/promises";

import { OPCODES } from "./constants";
import { Logger } from "winston";
import { tonNode_blockIdExt } from "ton-lite-client/dist/schema";

export default class TonTxProcessor {
  private limitPerTxQuery = 100; // limit per query
  private maxUnprocessTxs = 500; // this makes sure we dont process too many txs at once causing delays
  private initiallatestProcessedTxHash = "";

  constructor(
    protected readonly validator: TonbridgeValidatorInterface,
    protected readonly bridge: TonbridgeBridgeInterface,
    protected readonly liteClient: LiteClient,
    protected readonly blockProcessor: TonBlockProcessor,
    protected readonly jettonBridgeAddress: string,
    protected logger: Logger,
    protected latestProcessedTxHash: StringHex = ""
  ) {
    this.initiallatestProcessedTxHash = latestProcessedTxHash;
  }

  private async queryUnprocessedTransactions(
    masterchainInfo: tonNode_blockIdExt
  ) {
    const transactions: TransactionWithBlockId[] = [];
    const jettonAddr = address(this.jettonBridgeAddress);
    const accState = await this.liteClient.getAccountState(
      jettonAddr,
      masterchainInfo
    );
    let offset = {
      hash: accState.lastTx.hash.toString(16),
      lt: accState.lastTx.lt.toString(10),
    };
    this.logger.info("latest processed tx hash: " + this.latestProcessedTxHash);
    if (this.latestProcessedTxHash === offset.hash) return [];
    while (true) {
      this.logger.info("Current processing tx hash: " + offset.hash);
      // workaround. Bug of loadTransaction that causes the prev trans hash to be incomplete
      if (!offset.hash)
        throw new Error(
          "Offset hash is undefined. Re-processing this transaction batch!"
        );
      if (offset.hash.length < 64) {
        this.logger.error(
          "TonTxProcessor queryUnprocessedTransactions offset hash length < 64: " +
            offset.hash
        );
        while (offset.hash.length < 64) {
          offset.hash = "0" + offset.hash;
        }
        this.logger.error(
          "TonTxProcessor queryUnprocessedTransactions new offset hash: " +
            offset.hash
        );
      }
      const rawTxs = await this.liteClient.getAccountTransactions(
        jettonAddr,
        offset.lt,
        Buffer.from(offset.hash, "hex"),
        this.limitPerTxQuery
      );
      const txs = Cell.fromBoc(rawTxs.transactions).map((cell, i) => ({
        tx: loadTransaction(cell.asSlice()),
        blockId: rawTxs.ids[i],
      }));

      if (!this.latestProcessedTxHash) {
        transactions.push(...txs);
        if (transactions.length > 0)
          this.latestProcessedTxHash = transactions[0].tx
            .hash()
            .toString("hex");
        break;
      }

      const indexOf = txs.findIndex(
        (tx) => tx.tx.hash().toString("hex") === this.latestProcessedTxHash
      );
      if (indexOf === -1) {
        const oldestTx = txs[txs.length - 1].tx;
        if (!oldestTx.prevTransactionHash) {
          throw new Error(
            "TonTxProcessor queryUnprocessedTransactions new offset hash is undefined"
          );
        }
        transactions.push(...txs);
        // increase offset and continue querying txs until we find our oldest transaction that we can remember
        offset = {
          hash: oldestTx.prevTransactionHash.toString(16),
          lt: oldestTx.prevTransactionLt.toString(10),
        };
        await setTimeout(2000);
        continue;
      } else {
        // only push more txs if the latest is not the first index to avoid redundancy
        if (indexOf > 0) transactions.push(...txs.slice(0, indexOf));
        if (transactions.length > 0)
          this.latestProcessedTxHash = transactions[0].tx
            .hash()
            .toString("hex");
        break;
      }
    }
    return transactions;
  }

  async processTransactions(masterchainInfo: tonNode_blockIdExt) {
    try {
      const transactions =
        await this.queryUnprocessedTransactions(masterchainInfo);
      this.logger.info(
        "TonTxProcessor:unprocessed transactions: " + transactions.length
      );
      // since we query our transactions from latest to earliest -> process the latest txs first
      for (const tx of transactions) {
        try {
          await this.processTransaction(tx);
        } catch (error) {
          this.logger.error(
            "TonTxProcessor:Error processing transaction: ",
            error
          );
        }
      }
    } catch (error) {
      // reset latestProcessedTxHash so we can start over to prevent missed txs in case of having errors
      this.logger.error(
        "TonTxProcessor:Error querying unprocessed transactions: ",
        error
      );
      this.latestProcessedTxHash = this.initiallatestProcessedTxHash;
      return;
    }
  }

  async processTransaction(tx: TransactionWithBlockId) {
    const txHash = tx.tx.hash().toString("hex");
    const isTxProcessed = await this.bridge.isTxProcessed({
      txHash: txHash,
    });
    if (isTxProcessed) return;

    const messages = tx.tx.outMessages.values();
    let isValidTx = false;
    for (const message of messages) {
      if (message.info.type === "external-out") {
        //  load op-code
        const opcode = message.body.beginParse().loadUint(32);
        if (OPCODES.includes(opcode)) {
          isValidTx = true;
          break;
        }
      }
    }
    if (!isValidTx) {
      this.logger.info(
        `TonTxProcessor:Transaction ${txHash} is invalid tx. We ignore it.`
      );
      return;
    }
    try {
      // it means this tx is in a shard block -> we verify shard blocks along with materchain block
      if (tx.blockId.workchain !== -1) {
        await this.blockProcessor.verifyShardBlocks(tx.blockId);
      } else {
        await this.blockProcessor.verifyMasterchainBlockByBlockId(tx.blockId);
      }
    } catch (error) {
      this.logger.error(
        `TonTxProcessor:Cannot verify blocks related to transaction ${txHash}`,
        error
      );
      return;
    }

    const jettonAddr = address(this.jettonBridgeAddress);
    const txWithProof = await this.liteClient.getAccountTransaction(
      jettonAddr,
      tx.tx.lt.toString(10),
      tx.blockId
    );

    await this.bridge.readTransaction({
      txBoc: txWithProof.transaction.toString("hex"),
      txProof: txWithProof.proof.toString("hex"),
    });

    this.logger.info(
      `TonTxProcessor:sVerified tx with hash ${txHash} in block ${tx.blockId.seqno} successfully`
    );
  }
}
