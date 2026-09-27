use soroban_sdk::{
    contract, contractimpl, token::TokenClient, Address, BytesN, Env, String, Symbol, Vec,
};

use crate::errors;
use crate::errors::{fail, ContractError};
use crate::events;
use crate::storage;
use crate::types::{Bounty, BountyId, BountyMeta, Contributor, Milestone};

/// Maximum number of bounty ids returned by a single paginated query.
///
/// Soroban enforces hard limits on the number of ledger entries and the
/// amount of memory that may be read per invocation. Capping the page size
/// keeps `get_bounties_by_creator` within those limits even for creators
/// with hundreds of bounties.
pub const MAX_BOUNTIES_PAGE_LIMIT: u32 = 50;

#[contract]
pub struct MergeMintContract;

include!("mutations.rs");
include!("queries.rs");
