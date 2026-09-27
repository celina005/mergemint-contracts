import {
  Contract,
  SorobanRpc,
  TransactionBuilder,
  Networks,
  BASE_FEE,
  xdr,
  Address,
  nativeToScVal,
  scValToNative,
} from "@stellar/stellar-sdk";

export * from "./types";
import {
  NetworkConfig,
  Bounty,
  BountyMeta,
  Contributor,
  CreateBountyParams,
  MergeMintSdkError,
  RetryOptions,
} from "./types";

export const TESTNET: Omit<NetworkConfig, "contractId"> = {
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: Networks.TESTNET,
};

const MAINNET_RPC_PLACEHOLDER_PATTERN = /\/v1\/XCa\.\.\.$/;

export const MAINNET: Omit<NetworkConfig, "contractId"> = {
  rpcUrl: "https://mainnet.stellar.validationcloud.io/v1/XCa...",
  networkPassphrase: Networks.PUBLIC,
};

/**
 * Maximum number of bounty ids a single `getBountiesByCreator` page may return.
 * Mirrors the contract-side cap so clients can validate before submitting a read.
 */
export const MAX_BOUNTIES_BY_CREATOR_LIMIT = 50;

/**
 * Builds a full `NetworkConfig` by combining a base template (e.g. `TESTNET` or `MAINNET`)
 * with a specific `contractId` and optional overrides.
 */
export function createNetworkConfig(
  base: Omit<NetworkConfig, "contractId">,
  contractId: string,
  overrides?: Partial<Omit<NetworkConfig, "contractId">>
): NetworkConfig {
  return {
    ...base,
    contractId,
    ...overrides,
  };
}

// === Helpers

function addressToScVal(address: string): xdr.ScVal {
  return new Address(address).toScVal();
}

export function symbolToScVal(value: string): xdr.ScVal {
  if (value.length > 32) {
    throw new MergeMintSdkError(`value exceeds 32-character Symbol limit: ${value}`, "INVALID_ARGUMENT");
  }
  return nativeToScVal(value, { type: "symbol" });
}

function symbolVecToScVal(values: string[]): xdr.ScVal {
  return xdr.ScVal.scvVec(
    values.map((v) => symbolToScVal(v))
  );
}

function u32ToScVal(value: number): xdr.ScVal {
  return nativeToScVal(value, { type: "u32" });
}

function i128ToScVal(value: bigint): xdr.ScVal {
  return nativeToScVal(value, { type: "i128" });
}

function vecAddressToScVal(addresses: string[]): xdr.ScVal {
  return xdr.ScVal.scvVec(
    addresses.map((addr) => new Address(addr).toScVal())
  );
}

function optionVecAddressToScVal(addresses: string[] | undefined): xdr.ScVal {
  if (!addresses || addresses.length === 0) {
    return xdr.ScVal.scvVoid();
  }
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: nativeToScVal("Some", { type: "symbol" }),
      val: vecAddressToScVal(addresses),
    }),
  ]);
}

function optionU32ToScVal(value: number | null): xdr.ScVal {
  if (value === null) {
    return xdr.ScVal.scvVoid();
  }
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: nativeToScVal("Some", { type: "symbol" }),
      val: u32ToScVal(value),
    }),
  ]);
}

function milestoneToScVal(ms: { description: string; reward: bigint; completed: boolean }): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: nativeToScVal("description", { type: "symbol" }),
      val: symbolToScVal(ms.description),
    }),
    new xdr.ScMapEntry({
      key: nativeToScVal("reward", { type: "symbol" }),
      val: i128ToScVal(ms.reward),
    }),
    new xdr.ScMapEntry({
      key: nativeToScVal("completed", { type: "symbol" }),
      val: nativeToScVal(ms.completed, { type: "bool" }),
    }),
  ]);
}

function milestonesToScVal(milestones: Array<{ description: string; reward: bigint; completed: boolean }>): xdr.ScVal {
  return xdr.ScVal.scvVec(milestones.map(milestoneToScVal));
}

function bytesNToHex(scVal: xdr.ScVal): string {
  const bytes = scVal.bytes();
  return Buffer.from(bytes).toString("hex");
}

function hexToBytesN(hex: string): xdr.ScVal {
  const buf = Buffer.from(hex, "hex");
  return xdr.ScVal.scvBytes(buf);
}

function parseBounty(raw: unknown): Bounty {
  const map = raw as Record<string, unknown>;
  const assigneesRaw = (map.assignees as Array<[unknown, unknown]>) ?? [];
  const verifiersRaw = map.required_verifiers as Array<unknown> | null;
  const tagsRaw = (map.tags as Array<unknown>) ?? [];
  const milestonesRaw = (map.milestones as Array<Record<string, unknown>>) ?? [];
  return {
    creator: map.creator as string,
    rewardAmount: BigInt(map.reward_amount as string),
    rewardToken: map.reward_token as string,
    assignees: assigneesRaw.map(([addr, share]) => ({
      address: addr as string,
      shareBp: share as number,
    })),
    maxAssignees: map.max_assignees as number,
    status: map.status as string,
    minReputation: map.min_reputation as number,
    deadline: (map.deadline as number | null) ?? null,
    requiredVerifiers: verifiersRaw?.map((v) => v as string),
    approvalThreshold: (map.approval_threshold as number) ?? 1,
    tags: tagsRaw.map((t) => t as string),
    milestones: milestonesRaw.map((ms) => ({
      description: ms.description as string,
      reward: BigInt(ms.reward as string | number),
      completed: ms.completed as boolean,
    })),
  };
}

function parseContributor(raw: unknown): Contributor {
  const map = raw as Record<string, unknown>;
  return {
    address: map.address as string,
    reputation: map.reputation as number,
    totalEarned: BigInt(map.total_earned as string),
    contributionCount: map.contribution_count as number,
    activeClaims: map.active_claims as number,
    metadata: (map.metadata as string | null) ?? null,
  };
}

// === Retry

const NO_RETRY: RetryOptions = { attempts: 1, backoffMs: 0 };

function normalizeRetry(retry: RetryOptions | undefined): RetryOptions {
  if (!retry) return NO_RETRY;
  if (!Number.isInteger(retry.attempts) || retry.attempts < 1) {
    throw new Error(
      `Invalid retry.attempts: expected an integer >= 1, got ${retry.attempts}`
    );
  }
  if (!Number.isFinite(retry.backoffMs) || retry.backoffMs < 0) {
    throw new Error(
      `Invalid retry.backoffMs: expected a number >= 0, got ${retry.backoffMs}`
    );
  }
  return { attempts: retry.attempts, backoffMs: retry.backoffMs };
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// === SDK

export class MergeMintSDK {
  private readonly rpc: SorobanRpc.Server;
  private readonly contract: Contract;
  private readonly networkPassphrase: string;
  private readonly contractId: string;
  private readonly retry: RetryOptions;

  /**
   * Creates an SDK bound to a single Soroban RPC endpoint and contract.
   *
   * @param config - Network configuration. `rpcUrl` must be a real provider
   * endpoint, `contractId` the deployed MergeMint contract, and
   * `networkPassphrase` the passphrase of the target network (see {@link TESTNET}
   * and {@link MAINNET}). Pass `retry` to make every RPC round-trip tolerate
   * transient failures — see {@link RetryOptions}.
   * @throws Error if `rpcUrl` still contains a placeholder, or if `retry` holds
   * an out-of-range `attempts` or `backoffMs`.
   */
  constructor(config: NetworkConfig) {
    if (!config.contractId || typeof config.contractId !== "string" || config.contractId.trim() === "") {
      throw new MergeMintSdkError("Invalid contractId: contractId must be a non-empty string.", "INVALID_CONTRACT_ID");
    }
    if (config.contractId.includes("...") || config.contractId.startsWith("0x0000000000000000000000000000000000000000000000000000000000000000")) {
      throw new MergeMintSdkError(`Invalid contractId: placeholder or null address detected in configuration: "${config.contractId}".`, "INVALID_CONTRACT_ID");
    }
    if (config.rpcUrl.includes("XCa...") || config.rpcUrl.includes("...")) {
      throw new MergeMintSdkError("Invalid RPC URL: placeholder detected in configuration. Please provide a valid Soroban RPC provider URL.", "INVALID_RPC_URL");
    }
    this.rpc = new SorobanRpc.Server(config.rpcUrl);
    this.contract = new Contract(config.contractId.trim());
    this.networkPassphrase = config.networkPassphrase;
    this.contractId = config.contractId.trim();
    this.retry = normalizeRetry(config.retry);
  }

  // === Read methods (no transaction needed)

  /**
   * Reads a single bounty by id.
   *
   * @param bountyId - Bounty id as a hex-encoded `BytesN<32>` string.
   * @returns The decoded {@link Bounty}, or `null` when no bounty exists for `bountyId`.
   */
  async getBounty(bountyId: string): Promise<Bounty | null> {
    const result = await this.simulateRead("get_bounty", [hexToBytesN(bountyId)]);
    if (result === null || result === undefined) {
      return null;
    }
    return parseBounty(result);
  }

  /**
   * Reads a page of bounty ids created by `creator`.
   *
   * Ordering is stable across calls: the contract returns ids in the order they
   * were created, so paging with a fixed `limit` and increasing `offset` never
   * skips or duplicates entries.
   *
   * @param creator - Creator address (Stellar account or contract id).
   * @param offset - Number of ids to skip. Must be a non-negative integer.
   * @param limit - Maximum number of ids to return. Must be an integer in
   * `[1, MAX_BOUNTIES_BY_CREATOR_LIMIT]`.
   * @returns The page of bounty ids as hex-encoded `BytesN<32>` strings.
   * @throws MergeMintSdkError when `offset` or `limit` is out of range.
   */
  async getBountiesByCreator(
    creator: string,
    offset: number = 0,
    limit: number = MAX_BOUNTIES_BY_CREATOR_LIMIT
  ): Promise<string[]> {
    if (!Number.isInteger(offset) || offset < 0) {
      throw new MergeMintSdkError(
        `Invalid offset: expected an integer >= 0, got ${offset}`,
        "INVALID_ARGUMENT"
      );
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_BOUNTIES_BY_CREATOR_LIMIT) {
      throw new MergeMintSdkError(
        `Invalid limit: expected an integer in [1, ${MAX_BOUNTIES_BY_CREATOR_LIMIT}], got ${limit}`,
        "INVALID_ARGUMENT"
      );
    }
    const result = await this.simulateRead("get_bounties_by_creator", [
      addressToScVal(creator),
      u32ToScVal(offset),
      u32ToScVal(limit),
    ]);
    const ids = (result as Array<unknown> | null) ?? [];
    return ids.map((id) => bytesNToHex(id as xdr.ScVal));
  }

  /**
   * Counts the total number of bounties created by `creator`.
   *
   * Pair with {@link getBountiesByCreator} to render page controls:
   * `Math.ceil(count / limit)` yields the number of pages.
   *
   * @param creator - Creator address (Stellar account or contract id).
   * @returns The total number of bounties for `creator`.
   */
  async getBountyCountByCreator(creator: string): Promise<number> {
    const result = await this.simulateRead("get_bounty_count_by_creator", [
      addressToScVal(creator),
    ]);
    return Number(result ?? 0);
  }

  // === Internal helpers

  private async simulateRead(method: string, args: xdr.ScVal[]): Promise<unknown> {
    const operation = this.contract.call(method, ...args);
    const account = await this.rpc.getAccount(this.contractId);
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();
    const simulated = await this.rpc.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(simulated)) {
      throw new MergeMintSdkError(
        `Simulation failed for ${method}: ${simulated.error}`,
        "SIMULATION_FAILED"
      );
    }
    const retval = (simulated as SorobanRpc.Api.SimulateTransactionSuccessResponse).result?.retval;
    if (retval === undefined) {
      return null;
    }
    return scValToNative(retval);
  }
}
