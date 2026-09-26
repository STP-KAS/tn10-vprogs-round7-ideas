// Shared helpers for the TN10 break test. Testnet-10 only.
// Secrets are read from /home/box/secure and are never printed.
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";
const require = createRequire(import.meta.url);
globalThis.WebSocket = require("websocket").w3cwebsocket;
const SDK = process.env.KASPA_SDK || "/workspace/sdk210/kaspa-wasm32-sdk/nodejs/kaspa/kaspa.js";
export const kaspa = require(SDK);
export const NET = "testnet-10";
export const SECURE = "/home/box/secure";
export const WALLETS = `${SECURE}/tn10-break-wallets.json`;
export const NODES = { n0: "ws://127.0.0.1:17210", n1: "ws://127.0.0.1:17220" };

export function deskKey(index = 0) {
  const phrase = readFileSync(`${SECURE}/tn10-desk-mnemonic.txt`, "utf8").trim();
  const xprv = new kaspa.XPrv(new kaspa.Mnemonic(phrase).toSeed(""));
  const gen = new kaspa.PrivateKeyGenerator(xprv, false, 0n);
  return gen.receiveKey(index);
}
export function addrOf(pk) { return pk.toKeypair().toAddress(NET).toString(); }

// Throwaway wallets: hex keys kept in a mode-600 file, never logged.
export function loadWallets() {
  return existsSync(WALLETS) ? JSON.parse(readFileSync(WALLETS, "utf8")) : {};
}
export function ensureWallets(names) {
  const w = loadWallets();
  for (const n of names) {
    if (!w[n]) {
      const hex = randomBytes(32).toString("hex");
      const pk = new kaspa.PrivateKey(hex);
      w[n] = { key: hex, address: addrOf(pk) };
    }
  }
  writeFileSync(WALLETS, JSON.stringify(w, null, 1), { mode: 0o600 });
  chmodSync(WALLETS, 0o600);
  return w;
}
export function walletKey(name) { return new kaspa.PrivateKey(loadWallets()[name].key); }

export async function connect(node = "n1") {
  const rpc = new kaspa.RpcClient({ url: NODES[node], encoding: kaspa.Encoding.Borsh, networkId: NET });
  await rpc.connect();
  return rpc;
}
export const ts = () => new Date().toISOString();
export const log = (o) => console.log(JSON.stringify({ t: ts(), ...o }, (k, v) => typeof v === "bigint" ? v.toString() : v));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Convert an RPC UTXO entry reference to a plain entry for createTransactions.
export function plainEntry(u) {
  const e = u.entry ?? u;
  return e;
}
