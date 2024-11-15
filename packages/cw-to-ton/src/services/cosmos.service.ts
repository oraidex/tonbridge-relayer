import {
  CHANNEL,
  SyncData,
  SyncDataOptions,
  Txs,
} from "@oraichain/cosmos-rpc-sync";
import { Event, QueryClient } from "@cosmjs/stargate";
import { parseWasmEvents } from "@oraichain/oraidex-common";
import { Log } from "@cosmjs/stargate/build/logs";
import { EventEmitter } from "stream";
import { Packets, ICosmwasmParser } from "@src/@types/interfaces/cosmwasm";
import { Tendermint34Client } from "@cosmjs/tendermint-rpc";
import { LightClientData } from "@src/@types/interfaces/cosmwasm/serialized";
import { filterOutSuccessTx, retry } from "@src/utils";
import {
  getAckPacketProofs,
  getPacketProofs,
  serializeCommit,
  serializeHeader,
  serializeValidator,
} from "@oraichain/ton-bridge-contracts";
import { TransferPacket } from "@src/dtos/packets/TransferPacket";
import { AckPacket } from "@src/dtos/packets/AckPacket";
import { ExistenceProof } from "cosmjs-types/cosmos/ics23/v1/proofs";
import { Config } from "@src/config";
import { DuckDb } from "@src/duckdb.service";
import { CosmosBlockOffset } from "@src/models";

export const enum BRIDGE_WASM_ACTION {
  SEND_TO_TON = "send_to_ton",
  SEND_TO_COSMOS = "send_to_cosmos",
}

export class CosmwasmBridgeParser implements ICosmwasmParser<Packets> {
  constructor(private bridgeWasmAddress: string) {}

  processChunk(chunk: Txs): Packets {
    const { txs } = chunk;
    const transferPackets = [];
    const ackPackets = [];
    const allBridgeData = txs
      .filter(filterOutSuccessTx)
      .flatMap((tx) => {
        return this.extractEventToPacketDtos(
          tx.events,
          tx.hash,
          tx.height,
          tx.timestamp
        );
      })
      .filter(
        (data) => data.transferPackets.length > 0 || data.ackPackets.length > 0
      );

    allBridgeData.forEach((data) => {
      transferPackets.push(...data.transferPackets);
      ackPackets.push(...data.ackPackets);
    });

    return {
      transferPackets: transferPackets,
      ackPackets: ackPackets,
    };
  }

  extractEventToPacketDtos(
    events: readonly Event[],
    hash: string,
    height: number,
    timestamp: string
  ): Packets {
    const basicInfo = {
      hash: hash,
      height: height,
      timestamp: timestamp,
    };
    const wasmAttr = parseWasmEvents(events);
    const filterByContractAddress = (attr: Record<string, string>) =>
      attr["_contract_address"] === this.bridgeWasmAddress;

    const sendToTonEvents = wasmAttr
      .filter(filterByContractAddress)
      .filter((attr) => attr["action"] === BRIDGE_WASM_ACTION.SEND_TO_TON);

    const ackSendToCosmosEvents = wasmAttr
      .filter(filterByContractAddress)
      .filter((attr) => attr["action"] === BRIDGE_WASM_ACTION.SEND_TO_COSMOS);

    const transferPacket = sendToTonEvents.map((attr) => {
      return {
        data: TransferPacket.fromRawAttributes(attr),
        ...basicInfo,
      };
    });

    const ackPackets = ackSendToCosmosEvents.map((attr) => {
      return {
        data: AckPacket.fromRawAttributes(attr),
        ...basicInfo,
      };
    });

    return {
      transferPackets: transferPacket.length > 0 ? transferPacket : [],
      ackPackets: ackPackets.length > 0 ? ackPackets : [],
    };
  }
}

export enum CosmwasmWatcherEvent {
  DATA = "data",
}

export class CosmwasmWatcher<T> extends EventEmitter {
  public running = false;

  constructor(
    private syncData: SyncData,
    private cosmwasmParser: ICosmwasmParser<T>
  ) {
    super();
  }

  async start() {
    if (this.syncData && this.running) {
      this.syncData.destroy();
    }
    this.running = true;
    this.syncData.startSpecificService("polling");
    this.syncData.on(CHANNEL.QUERY, async (chunk: Txs) => {
      try {
        const parsedData = this.cosmwasmParser.processChunk(chunk) as Packets;
        const { offset } = chunk;
        if (
          parsedData &&
          (parsedData.transferPackets.length > 0 ||
            parsedData.ackPackets.length > 0)
        ) {
          this.emit(CosmwasmWatcherEvent.DATA, { ...parsedData, offset });
        } else {
          this.emit(CosmwasmWatcherEvent.DATA, { offset });
        }
      } catch (e) {
        this.emit("error", `CosmwasmWatcher:Error when parsing data:${e}`);
      }
    });
  }

  clearSyncData() {
    this.running = false;
    this.syncData.destroy();
  }

  setSyncData(syncData: SyncData) {
    this.syncData = syncData;
  }
}

export class CosmosProofHandler {
  cosmosRpcUrl: string;
  cosmosBridgeAddress: string;
  queryClient: QueryClient;

  constructor(
    cosmosRpcUrl: string,
    cosmosBridgeAddress: string,
    queryClient: QueryClient
  ) {
    this.cosmosRpcUrl = cosmosRpcUrl;
    this.cosmosBridgeAddress = cosmosBridgeAddress;
    this.queryClient = queryClient;
  }

  static async create(
    cosmosRpcUrl: string,
    cosmosBridgeAddress: string
  ): Promise<CosmosProofHandler> {
    const queryClient = new QueryClient(
      await Tendermint34Client.connect(cosmosRpcUrl)
    );
    return new CosmosProofHandler(
      cosmosRpcUrl,
      cosmosBridgeAddress,
      queryClient
    );
  }

  async createUpdateClientData(height: number): Promise<LightClientData> {
    try {
      const tendermintClient = await Tendermint34Client.connect(
        this.cosmosRpcUrl
      );
      const [
        {
          block: { lastCommit },
        },
        {
          block: { header },
        },
        { validators },
      ] = await retry(() => {
        return Promise.all([
          tendermintClient.block(height + 1),
          tendermintClient.block(height),
          tendermintClient.validators({
            height,
            per_page: 100,
          }),
        ]);
      });

      return {
        validators: validators.map(serializeValidator),
        lastCommit: serializeCommit(lastCommit),
        header: serializeHeader(header),
      };
    } catch (e) {
      throw new Error(
        `CosmwasmProofHandler:Error when createUpdateClientData:${e}`
      );
    }
  }

  async getPacketProofs(
    provenHeight: number,
    seq: bigint
  ): Promise<ExistenceProof[]> {
    return retry(
      async () => {
        try {
          const proofs = await getPacketProofs(
            this.queryClient as any,
            this.cosmosBridgeAddress,
            provenHeight,
            seq
          );
          return proofs;
        } catch (e) {
          throw new Error(
            `CosmwasmProofHandler:Error when getPacketProofs:${e}`
          );
        }
      },
      3,
      2000
    ) as Promise<ExistenceProof[]>;
  }

  async getAckPacketProofs(
    provenHeight: number,
    seq: bigint
  ): Promise<ExistenceProof[]> {
    return retry(
      async () => {
        try {
          const proofs = await getAckPacketProofs(
            this.queryClient as any,
            this.cosmosBridgeAddress,
            provenHeight,
            seq
          );
          return proofs;
        } catch (e) {
          throw new Error(
            `CosmwasmProofHandler:Error when getAckPacketProofs:${e}`
          );
        }
      },
      3,
      2000
    ) as Promise<ExistenceProof[]>;
  }
}

export const createUpdateClientData = async (
  rpcUrl: string,
  height: number
): Promise<LightClientData> => {
  try {
    const tendermintClient = await Tendermint34Client.connect(rpcUrl);
    const [
      {
        block: { lastCommit },
      },
      {
        block: { header },
      },
      { validators },
    ] = await Promise.all([
      tendermintClient.block(height + 1),
      tendermintClient.block(height),
      tendermintClient.validators({
        height,
        per_page: 100,
      }),
    ]);

    return {
      validators: validators.map(serializeValidator),
      lastCommit: serializeCommit(lastCommit),
      header: serializeHeader(header),
    };
  } catch (e) {
    throw new Error(`Error when createUpdateClientData: ${e}`);
  }
};

export const createCosmosBridgeWatcher = async (config: Config) => {
  const duckDb = await DuckDb.getInstance(config.connectionString);
  const blockOffset = new CosmosBlockOffset(duckDb);
  await blockOffset.createTable();
  const offset = await blockOffset.mayLoadBlockOffset(config.syncBlockOffSet);
  const syncDataOpt: SyncDataOptions = {
    rpcUrl: config.cosmosRpcUrl,
    limit: config.syncLimit,
    maxThreadLevel: config.syncThreads,
    offset: offset,
    interval: config.syncInterval,
    queryTags: [],
  };
  if (offset < config.syncBlockOffSet) {
    syncDataOpt.offset = config.syncBlockOffSet;
  }
  const syncData = new SyncData(syncDataOpt);
  await syncData.initClient();
  const bridgeParser = new CosmwasmBridgeParser(config.wasmBridge);
  const cosmwasmWatcher = new CosmwasmWatcher(syncData, bridgeParser);
  return cosmwasmWatcher;
};
