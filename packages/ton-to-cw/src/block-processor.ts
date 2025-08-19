import { TonbridgeValidatorInterface } from "@oraichain/tonbridge-contracts-sdk";
import { UserFriendlyValidator } from "@oraichain/tonbridge-contracts-sdk/build/TonbridgeValidator.types";
import TonRocks, {
  ParsedBlock,
  ValidatorSignature,
} from "@oraichain/tonbridge-utils";
import { BlockID, LiteClient } from "ton-lite-client";
import {
  Functions,
  liteServer_BlockData,
  tonNode_blockIdExt,
} from "ton-lite-client/dist/schema";
import TonWeb from "tonweb";
import { Logger } from "winston";

export default class TonBlockProcessor {
  // cache validator set so we don't have to call the contract every few seconds
  private allValidators: UserFriendlyValidator[] = [];
  private keyBlockCacheData: {
    parsedBlock: ParsedBlock;
    rawBlockData: liteServer_BlockData;
    initialKeyBlockInformation: tonNode_blockIdExt;
  } = {
    parsedBlock: null,
    rawBlockData: null,
    initialKeyBlockInformation: null,
  };

  constructor(
    protected readonly validator: TonbridgeValidatorInterface,
    protected readonly liteClient: LiteClient,
    protected readonly tonweb: TonWeb,
    protected logger: Logger
  ) {}

  async isBlockVerified(rootHash: Buffer) {
    try {
      const isBlockVerified = await this.validator.isVerifiedBlock({
        rootHash: rootHash.toString("hex"),
      });

      return isBlockVerified;
    } catch (error) {
      this.logger.error(`Error querying block verification status`, error);
      return false;
    }
  }

  async queryKeyBlock(masterChainSeqNo: number) {
    let initBlockSeqno = masterChainSeqNo;
    while (true) {
      this.logger.info("finding key block with seqno: " + initBlockSeqno);
      const fullBlock = await this.liteClient.getFullBlock(initBlockSeqno);
      const initialBlockInformation = fullBlock.shards.find(
        (blockRes) => blockRes.seqno === initBlockSeqno
      );
      // get block
      const block = await this.liteClient.engine.query(
        Functions.liteServer_getBlock,
        {
          kind: "liteServer.getBlock",
          id: {
            kind: "tonNode.blockIdExt",
            ...initialBlockInformation,
          },
        }
      );

      const parsedBlock: ParsedBlock = await this.parseBlock(block);
      this.logger.info(
        "is parsed block a keyblock? " + parsedBlock.info.key_block
      );
      if (!parsedBlock.info.key_block) {
        // use read-through cache instead for simplicity
        if (
          this.keyBlockCacheData.initialKeyBlockInformation &&
          this.keyBlockCacheData.initialKeyBlockInformation.seqno ===
            parsedBlock.info.prev_key_block_seqno
        ) {
          this.logger.info("Current keyblock cache hit");
          // return cache instead
          return this.keyBlockCacheData;
        }
        initBlockSeqno = parsedBlock.info.prev_key_block_seqno;
        continue;
      }
      // cache our data to save bandwidth
      this.keyBlockCacheData = {
        parsedBlock,
        rawBlockData: block,
        initialKeyBlockInformation: {
          ...initialBlockInformation,
          kind: "tonNode.blockIdExt",
        },
      };
      return this.keyBlockCacheData;
    }
  }

  async getMasterchainInfo() {
    return this.liteClient.getMasterchainInfo();
  }

  async parseBlock(block: liteServer_BlockData): Promise<ParsedBlock> {
    const [rootCell] = await TonRocks.types.Cell.fromBoc(
      block.data.toString("hex")
    );

    // Additional check for rootHash
    const rootHash = Buffer.from(rootCell.hashes[0]).toString("hex");
    if (rootHash !== block.id.rootHash.toString("hex")) {
      throw Error("got wrong block or here was a wrong root_hash format");
    }

    const parsedBlock = TonRocks.bc.BlockParser.parseBlock(rootCell);
    return parsedBlock;
  }

  queryAllValidators = async () => {
    let validators: UserFriendlyValidator[] = [];
    let startAfter = undefined;
    const valCheck = new Set();

    while (true) {
      const validatorsTemp = await this.validator.getValidators({
        limit: 100,
        startAfter,
      });
      if (validatorsTemp.length === 0) {
        break;
      }
      validators = validators.concat(validatorsTemp);
      startAfter = validatorsTemp[validatorsTemp.length - 1].node_id;
    }

    return validators.filter((val) => {
      if (valCheck.has(val.node_id)) {
        return false;
      }
      valCheck.add(val.node_id);
      return true;
    });
  };

  queryAllValidatorCandidates = async () => {
    let candidates: UserFriendlyValidator[] = [];
    let startAfter = 0;

    while (true) {
      const candidatesTemp = await this.validator.getCandidatesForValidators({
        limit: 30,
        startAfter,
        order: 0,
      });
      if (candidatesTemp.length === 0) {
        break;
      }
      candidates = candidates.concat(candidatesTemp);
      startAfter = candidates.length;
    }
    return candidates;
  };

  async verifyMasterchainBlock(seqno: number) {
    console.log("prepare to verify masterchain block: ", seqno);
    const fullBlock = await this.liteClient.getFullBlock(seqno);
    const blockId = fullBlock.shards.find(
      (blockRes) => blockRes.seqno === seqno
    );
    await this.verifyMasterchainBlockByBlockId(blockId);
  }

  async verifyMasterchainBlockByBlockId(blockId: BlockID) {
    const isBlockVerified = await this.isBlockVerified(blockId.rootHash);
    if (isBlockVerified) return;

    const vdata = await this.getMasterchainBlockValSignatures(blockId.seqno);
    this.logger.info("vdata length: " + vdata.length);
    const blockHeader = await this.liteClient.getBlockHeader(blockId);

    await this.validator.verifyMasterchainBlockByValidatorSignatures({
      blockHeaderProof: blockHeader.headerProof.toString("hex"),
      fileHash: blockHeader.id.fileHash.toString("hex"),
      vdata,
    });
    this.logger.info(
      `verified masterchain block ${blockId.seqno} successfully`
    );
  }

  async verifyMasterchainKeyBlock(rawBlockData: liteServer_BlockData) {
    const isBlockVerified = await this.isBlockVerified(
      rawBlockData.id.rootHash
    );
    if (isBlockVerified) return;
    const keyblockBoc = rawBlockData.data.toString("hex");
    await this.validator.prepareNewKeyBlock({
      keyblockBoc,
    });
    const vdata = await this.getMasterchainBlockValSignatures(
      rawBlockData.id.seqno
    );

    await this.validator.verifyKeyBlock({
      rootHash: rawBlockData.id.rootHash.toString("hex"),
      fileHash: rawBlockData.id.fileHash.toString("hex"),
      vdata,
    });
    this.logger.info(
      `verified masterchain keyblock ${rawBlockData.id.seqno} successfully`
    );
  }

  private async getMasterchainBlockValSignatures(seqno: number) {
    const valSignatures = (await this.tonweb.provider.send(
      "getMasterchainBlockSignatures",
      {
        seqno,
      }
    )) as any;
    const signatures = valSignatures.signatures as ValidatorSignature[];
    const vdata = signatures.map((sig) => {
      const signatureBuffer = Buffer.from(sig.signature, "base64");
      const r = signatureBuffer.subarray(0, 32);
      const s = signatureBuffer.subarray(32);
      return {
        node_id: Buffer.from(sig.node_id_short, "base64").toString("hex"),
        r: r.toString("hex"),
        s: s.toString("hex"),
      };
    });
    return vdata;
  }

  async verifyShardBlocks(shardId: BlockID) {
    const isBlockVerified = await this.isBlockVerified(shardId.rootHash);
    if (isBlockVerified) return;

    const shardProof = await this.liteClient.engine.query(
      Functions.liteServer_getShardBlockProof,
      {
        kind: "liteServer.getShardBlockProof",
        id: {
          kind: "tonNode.blockIdExt",
          ...shardId,
        },
      }
    );

    // gotta verify masterchain block first before verifying shard blocks
    await this.verifyMasterchainBlockByBlockId(shardProof.masterchainId);

    const mcBlockRootHash = shardProof.masterchainId.rootHash.toString("hex");
    await this.validator.verifyShardBlocks({
      mcBlockRootHash: mcBlockRootHash,
      shardProofLinks: shardProof.links.map((link) =>
        link.proof.toString("hex")
      ),
    });

    this.logger.info(
      `verified shard blocks ${JSON.stringify(
        shardProof.links.map((link) => link.id.seqno)
      )} successfully`
    );
  }
}
