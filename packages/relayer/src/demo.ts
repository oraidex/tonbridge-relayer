import { beginCell, Cell, toNano } from "@ton/core";
import { Blockchain } from "@ton/sandbox";
import { MOCK_BOC } from "./contracts/ton/boc/mock";
import { LightClient } from "./contracts/ton/LightClient";
import { BridgeAdapter, Src } from "./contracts/ton/BridgeAdapter";
import { envConfig } from "./config";
import { ConnectionOptions } from "bullmq";
import { createCosmosWorker, createTonWorker } from "./worker";
import { relay } from ".";
import { JettonMinter } from "./contracts/ton/JettonMinter";
import { DirectSecp256k1HdWallet } from "@cosmjs/proto-signing";
import { SigningCosmWasmClient } from "@cosmjs/cosmwasm-stargate";
import { ReadWriteStateClient } from "./contracts/cosmwasm/mock";
import { GasPrice } from "@cosmjs/stargate";
import { JettonWallet } from "./contracts/ton/JettonWallet";

(async () => {
  // Setup
  const blockchain = await Blockchain.create();
  const lightClientCode = Cell.fromBoc(
    Buffer.from(MOCK_BOC.LIGHT_CLIENT, "hex")
  )[0];
  const bridgeAdapterCode = Cell.fromBoc(
    Buffer.from(MOCK_BOC.BRIDGE_ADAPTER, "hex")
  )[0];
  const jettonWalletCode = Cell.fromBoc(
    Buffer.from(MOCK_BOC.JETTON_WALLET, "hex")
  )[0];
  const jettonMinterCode = Cell.fromBoc(
    Buffer.from(MOCK_BOC.JETTON_MINTER, "hex")
  )[0];
  // Deploying to TON sandbox blockchain
  const deployer = await blockchain.treasury("deployer");
  const sender = deployer.getSender();
  // setup empty user balance
  const user = await blockchain.treasury("user", { balance: 0n });
  const lightClient = blockchain.openContract(
    LightClient.createFromConfig(
      {
        chainId: "Oraichain",
        height: 1,
        validatorHashSet: "",
        dataHash: "",
        nextValidatorHashSet: "",
      },
      lightClientCode
    )
  );
  await lightClient.sendDeploy(sender, toNano("0.5"));
  console.log("[Demo] Deployed LightClient at", lightClient.address.toString());
  const bridgeAdapter = blockchain.openContract(
    BridgeAdapter.createFromConfig(
      {
        light_client: lightClient.address,
        bridge_wasm_smart_contract: envConfig.BRIDGE_WASM_ADDRESS,
        jetton_wallet_code: jettonWalletCode,
      },
      bridgeAdapterCode
    )
  );
  await bridgeAdapter.sendDeploy(sender, toNano("0.05"));
  console.log(
    "[Demo] Deployed bridgeAdapter at",
    bridgeAdapter.address.toString()
  );
  const jettonMinterSrcCosmos = blockchain.openContract(
    JettonMinter.createFromConfig(
      {
        adminAddress: bridgeAdapter.address,
        content: bridgeAdapterCode,
        jettonWalletCode: jettonWalletCode,
      },
      jettonMinterCode
    )
  );
  await jettonMinterSrcCosmos.sendDeploy(sender, toNano("0.05"));
  console.log(
    "[Demo] Deployed jettonMinterSrcCosmos at",
    jettonMinterSrcCosmos.address.toString()
  );
  const jettonMinterSrcTon = blockchain.openContract(
    JettonMinter.createFromConfig(
      {
        adminAddress: deployer.address,
        content: beginCell().endCell(),
        jettonWalletCode: jettonWalletCode,
      },
      jettonMinterCode
    )
  );
  await jettonMinterSrcTon.sendDeploy(sender, toNano("0.05"));
  console.log(
    "[Demo] Deployed jettonMinterSrcTon at",
    jettonMinterSrcTon.address.toString()
  );
  // TODO: investigate fees mechanism suitable for our contract
  // Send ton to contract to PayFees
  await deployer.getSender().send({
    to: bridgeAdapter.address,
    value: toNano("1000"),
  });

  await deployer.getSender().send({
    to: jettonMinterSrcCosmos.address,
    value: toNano("1000"),
  });

  await deployer.getSender().send({
    to: jettonMinterSrcTon.address,
    value: toNano("1000"),
  });

  await jettonMinterSrcTon.sendMint(deployer.getSender(), {
    toAddress: bridgeAdapter.address,
    jettonAmount: toNano(1000000000),
    amount: toNano(0.5), // deploy fee
    queryId: 0,
    value: toNano(1),
  });

  // SigningCosmwasmClient
  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(
    envConfig.MNEMONIC,
    {
      prefix: "orai",
    }
  );
  const accounts = await wallet.getAccounts();
  const cosmosClient = await SigningCosmWasmClient.connectWithSigner(
    envConfig.COSMOS_RPC_URL,
    wallet,
    {
      gasPrice: GasPrice.fromString("0.002orai"),
    }
  );
  const bridgeWasm = new ReadWriteStateClient(
    cosmosClient,
    accounts[0].address,
    envConfig.BRIDGE_WASM_ADDRESS
  );
  // Run workers
  const connection: ConnectionOptions = {
    host: envConfig.REDIS_HOST,
    port: envConfig.REDIS_PORT,
  };
  const tonWorker = createTonWorker(
    connection,
    sender,
    lightClient,
    bridgeAdapter
  );
  const cosmosWorker = createCosmosWorker(connection, bridgeWasm);
  tonWorker.run();
  cosmosWorker.run();
  // Start watching
  await relay();
  const transferCw20 = await bridgeWasm.transferToTon({
    to: user.address.toString(),
    denom: jettonMinterSrcCosmos.address.toString(),
    amount: "1000000000",
    crcSrc: Src.COSMOS.toString(),
  });
  console.log("[Demo] Transfer CW20 to TON", transferCw20.transactionHash);
  const transferJetton = await bridgeWasm.transferToTon({
    to: user.address.toString(),
    denom: jettonMinterSrcTon.address.toString(),
    amount: "1000000000",
    crcSrc: Src.TON.toString(),
  });
  console.log("[Demo] Transfer jetton to TON", transferJetton.transactionHash);
  tonWorker.on("completed", async (job) => {
    const data = job.data;
    const cellBuffer = data.data;
    const sliceData = beginCell()
      .storeBuffer(Buffer.from(cellBuffer, "hex"))
      .endCell()
      .beginParse();
    const to = sliceData.loadAddress();
    const denom = sliceData.loadAddress();
    const amount = sliceData.loadUint(128);
    const crcSrc = sliceData.loadUint(32);
    if (crcSrc === Src.COSMOS) {
      console.log(
        "[TON-WORKER-EVENT-COMPLETED] Success transferTo",
        to.toString(),
        amount,
        denom.toString(),
        "src::cosmos"
      );
      const userJettonWallet = await jettonMinterSrcCosmos.getWalletAddress(to);
      const userJettonWalletBalance =
        JettonWallet.createFromAddress(userJettonWallet);
      const wallet = blockchain.openContract(userJettonWalletBalance);
      const balance = await wallet.getBalance();
      console.log(
        "[TON-WORKER-EVENT-COMPLETED] user",
        user.address.toString(),
        "balance",
        balance.amount,
        "denom",
        jettonMinterSrcCosmos.address.toString()
      );
    } else {
      console.log(
        "[TON-WORKER-EVENT-COMPLETED] Success transferTo",
        to.toString(),
        amount,
        denom.toString(),
        "src::ton"
      );
      const userJettonWallet = await jettonMinterSrcTon.getWalletAddress(to);
      const userJettonWalletBalance =
        JettonWallet.createFromAddress(userJettonWallet);
      const wallet = blockchain.openContract(userJettonWalletBalance);
      const balance = await wallet.getBalance();
      console.log(
        "[TON-WORKER-EVENT-COMPLETED] user",
        user.address.toString(),
        "balance",
        balance.amount,
        "denom",
        jettonMinterSrcTon.address.toString()
      );
    }
  });
})();