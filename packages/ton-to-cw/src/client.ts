import * as cosmwasm from "@cosmjs/cosmwasm-stargate";
import { DirectSecp256k1HdWallet } from "@cosmjs/proto-signing";
import "dotenv/config";
import { GasPrice } from "@cosmjs/stargate";

export const initQueryClient = async () => {
  const client = await cosmwasm.CosmWasmClient.connect(
    process.env.RPC_URL || "https://rpc.orai.io/"
  );
  return client;
};

export const initSignClient = async (
  mnemonic: string,
  rpcUrl: string = "https://rpc.orai.io",
  prefix: string = "orai",
  denom: string = "orai",
  gasFee: string = "0.001"
) => {
  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, {
    // hdPaths: [stringToPath(chain.HD_PATH || "m/44'/118'/0'/0/0")],
    prefix,
  });

  const [firstAccount] = await wallet.getAccounts();

  const client = await cosmwasm.SigningCosmWasmClient.connectWithSigner(
    rpcUrl,
    wallet,
    {
      gasPrice: GasPrice.fromString(`${gasFee}${denom}`),
      broadcastPollIntervalMs: 500,
    }
  );
  return { sender: firstAccount.address, client };
};
