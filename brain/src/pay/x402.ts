// Paying an HTTP 402 with x402: USDC on Base Sepolia (testnet), from the wallet in PAYER_PRIVATE_KEY.
// The challenge comes from the response's `payment-required` header; paying replays the request through x402's fetch
// wrapper, which signs the payment and returns the paid response and its settlement.
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { privateKeyToAccount } from "viem/accounts";

const NETWORK = "eip155:84532"; // Base Sepolia
const EXPLORER = "https://sepolia.basescan.org/tx/";

export interface Challenge {
    amountUsd: number;
    payTo: string;
    network: string;
    asset: string;
}

export interface Paid {
    ok: boolean;
    status?: number;
    headers?: Record<string, string>;
    body?: string; // base64
    txHash?: string;
    explorerUrl?: string;
    error?: string;
}

/** The x402 challenge in a 402's headers, or null if there isn't one. */
export function parseChallenge(headers: Record<string, string>): Challenge | null {
    const h = Object.entries(headers).find(([k]) => k.toLowerCase() === "payment-required")?.[1];
    if (!h) return null;
    const required = decodePaymentRequiredHeader(h);
    const accept = required.accepts.find((x) => x.network === NETWORK) ?? required.accepts[0];
    if (!accept) return null;
    return { amountUsd: Number(accept.amount) / 1e6, payTo: accept.payTo, network: accept.network, asset: accept.asset }; // USDC: 6 decimals
}

let fetchWithPayment: typeof fetch | null | undefined;
function payer(): typeof fetch | null {
    if (fetchWithPayment !== undefined) return fetchWithPayment;
    const key = process.env.PAYER_PRIVATE_KEY;
    const account = key ? privateKeyToAccount(key as `0x${string}`) : null;
    fetchWithPayment = account ? wrapFetchWithPaymentFromConfig(fetch, { schemes: [{ network: NETWORK, client: new ExactEvmScheme(account) }] }) : null;
    return fetchWithPayment;
}

/** Replay the request, paying for it. */
export async function pay(url: string, init: RequestInit): Promise<Paid> {
    const f = payer();
    if (!f) return { ok: false, error: "no wallet (PAYER_PRIVATE_KEY)" };
    try {
        const res = await f(url, init);
        const settle = res.headers.get("payment-response");
        const tx = settle ? decodePaymentResponseHeader(settle) : null;
        const out: Paid = { ok: false, status: res.status, headers: Object.fromEntries(res.headers), body: Buffer.from(await res.arrayBuffer()).toString("base64") };
        if (!res.ok || !tx?.success) {
            let reason = tx?.errorReason;
            const again = res.headers.get("payment-required");
            if (!reason && again) {
                try {
                    reason = decodePaymentRequiredHeader(again).error;
                } catch {}
            }
            return { ...out, error: reason?.includes("insufficient_balance") ? "not enough USDC in the wallet" : (reason ?? `HTTP ${res.status}`).replace(/_/g, " ") };
        }
        return { ...out, ok: true, txHash: tx.transaction, explorerUrl: EXPLORER + tx.transaction };
    } catch (err) {
        return { ok: false, error: (err as Error).message };
    }
}
