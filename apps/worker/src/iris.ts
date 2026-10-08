import type { Hex } from "viem";
import type { IrisMessagesResponse } from "@sentinel/core";

export interface IrisClient {
  /** Returns null when Iris has not indexed the transaction yet (HTTP 404). */
  getMessages(sourceDomain: number, transactionHash: Hex): Promise<IrisMessagesResponse | null>;
}

export function createIrisClient(baseUrl: string, fetchImpl: typeof fetch = fetch): IrisClient {
  return {
    async getMessages(sourceDomain, transactionHash) {
      const url = new URL(`/v2/messages/${sourceDomain}`, baseUrl);
      url.searchParams.set("transactionHash", transactionHash);
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`Iris ${res.status} for ${url.pathname}`);
      return (await res.json()) as IrisMessagesResponse;
    },
  };
}
